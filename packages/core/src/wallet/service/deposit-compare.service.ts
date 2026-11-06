import { and, eq, or, sql } from 'drizzle-orm';
import {
  DrizzleService,
  makeConflictError,
  moneyAdd,
  moneyCompare,
  moneyDivide,
  moneyScaleBy,
  moneySubtract,
} from '@openora/core/server';
import {
  MAX_PLAYER_SEGMENT_PAGE,
  userIdsOfPlayers,
  type ExchangeRateReader,
  type IdentityReader,
  type Player,
  type PlayerSegmentReader,
  type TagKey,
  type User,
} from '@openora/core/contracts';
import { wallet, walletTransaction } from '../schema/index.js';
import {
  DEPOSIT_COMPARE_MAX_SEGMENT,
  type DepositCompare,
  type DepositCompareInput,
  type DepositCompareOrder,
  type DepositWindow,
  type PlayerDepositChange,
} from '../contract/index.js';
import { depositedAt } from './wallet.service.js';
import { pricedInPivot, withQuoteCache } from './pivot-pricing.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const SegmentTooLargeError = makeConflictError(
  'SegmentTooLargeError',
  `a deposit comparison reads at most ${DEPOSIT_COMPARE_MAX_SEGMENT} players`,
);

type PricedPlayer = Omit<PlayerDepositChange, 'changePct'>;

type DepositRow = { userId: User['id']; currency: string; depositsA: string; depositsB: string };

export type DepositCompareDeps = {
  drizzle: DrizzleService;
  segments: PlayerSegmentReader;
  identity: IdentityReader;
  rates: ExchangeRateReader | undefined;
  pivotCurrency: string;
};

/** `change` as a percentage of `depositsA` to one decimal; null when there is nothing to compare to. */
export function changePercent({ depositsA, change }: PricedPlayer): number | null {
  if (moneyCompare(depositsA, '0') === 0) {
    return null;
  }
  return Math.round(Number(moneyDivide(moneyScaleBy(change, '100'), depositsA)) * 10) / 10;
}

/**
 * The players whose deposits moved the way `order` asks, largest change first and ties by
 * player id, at most `limit` of them.
 */
export function rankDepositChanges(
  players: readonly PricedPlayer[],
  order: DepositCompareOrder,
  limit: number,
) {
  const direction = order === 'largest_drop' ? -1 : 1;
  const moved = players
    .filter((player) => moneyCompare(player.change, '0') === direction)
    .sort(
      (left, right) =>
        direction * moneyCompare(right.change, left.change) ||
        left.playerId.localeCompare(right.playerId),
    );
  return {
    players: moved
      .slice(0, limit)
      .map((player) => ({ ...player, changePct: changePercent(player) })),
    truncated: moved.length > limit,
  };
}

function groupByUser(rows: readonly DepositRow[]): Map<User['id'], DepositRow[]> {
  const byUser = new Map<User['id'], DepositRow[]>();
  for (const row of rows) {
    byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row]);
  }
  return byUser;
}

const startOf = (isoDay: string) => new Date(isoDay);
const endOf = (isoDay: string) => new Date(Date.parse(isoDay) + DAY_MS);

function inWindow({ from, to }: DepositWindow) {
  return sql`${depositedAt()} >= ${startOf(from)}::timestamptz and ${depositedAt()} < ${endOf(to)}::timestamptz`;
}

/**
 * Completed deposits of a tagged segment in two windows, priced per player into the fx pivot.
 * Reads the segment a page at a time: one query resolves a page's user ids and one sums its
 * deposits.
 */
export class DepositCompareService {
  constructor(private readonly deps: DepositCompareDeps) {}

  async compare({
    tag,
    windowA,
    windowB,
    order,
    limit,
  }: DepositCompareInput): Promise<DepositCompare> {
    const [segment] = await this.deps.segments.describe([tag]);
    if ((segment?.playerCount ?? 0) > DEPOSIT_COMPARE_MAX_SEGMENT) {
      throw new SegmentTooLargeError();
    }
    const rates = this.deps.rates && withQuoteCache(this.deps.rates);
    const priced: PricedPlayer[] = [];
    let playersInSegment = 0;
    let unpricedPlayers = 0;
    for await (const playerIds of this.segmentPages(tag)) {
      playersInSegment += playerIds.length;
      const page = await this.pricePage(playerIds, { windowA, windowB }, rates);
      priced.push(...page.priced);
      unpricedPlayers += page.unpriced;
    }
    const totals = priced.reduce(
      (sum, player) => ({
        windowA: moneyAdd(sum.windowA, player.depositsA),
        windowB: moneyAdd(sum.windowB, player.depositsB),
      }),
      { windowA: '0', windowB: '0' },
    );
    return {
      tag,
      playersInSegment,
      pivotCurrency: this.deps.pivotCurrency,
      totals,
      ...rankDepositChanges(priced, order, limit),
      unpricedPlayers,
    };
  }

  private async *segmentPages(tag: TagKey): AsyncGenerator<Player['id'][]> {
    let after: Player['id'] | undefined;
    let read = 0;
    do {
      const page = await this.deps.segments.page({
        tags: [tag],
        limit: MAX_PLAYER_SEGMENT_PAGE,
        ...(after === undefined ? {} : { after }),
      });
      read += page.playerIds.length;
      if (read > DEPOSIT_COMPARE_MAX_SEGMENT) {
        throw new SegmentTooLargeError();
      }
      yield page.playerIds;
      after = page.next ?? undefined;
    } while (after !== undefined);
  }

  private async pricePage(
    playerIds: readonly Player['id'][],
    windows: { windowA: DepositWindow; windowB: DepositWindow },
    rates: ExchangeRateReader | undefined,
  ) {
    const userIdByPlayer = await userIdsOfPlayers(this.deps.identity, playerIds);
    const rowsByUser = groupByUser(await this.depositsOf([...userIdByPlayer.values()], windows));
    const priced: PricedPlayer[] = [];
    let unpriced = 0;
    for (const [playerId, userId] of userIdByPlayer) {
      const rows = rowsByUser.get(userId);
      if (!rows) {
        continue;
      }
      const [depositsA, depositsB] = await Promise.all([
        this.priced(
          rows.map((row) => ({ currency: row.currency, total: row.depositsA })),
          rates,
        ),
        this.priced(
          rows.map((row) => ({ currency: row.currency, total: row.depositsB })),
          rates,
        ),
      ]);
      if (depositsA === null || depositsB === null) {
        unpriced += 1;
        continue;
      }
      priced.push({ playerId, depositsA, depositsB, change: moneySubtract(depositsB, depositsA) });
    }
    return { priced, unpriced };
  }

  private priced(
    rows: readonly { currency: string; total: string }[],
    rates: ExchangeRateReader | undefined,
  ) {
    return pricedInPivot(rows, this.deps.pivotCurrency, rates);
  }

  private async depositsOf(
    userIds: readonly User['id'][],
    { windowA, windowB }: { windowA: DepositWindow; windowB: DepositWindow },
  ): Promise<DepositRow[]> {
    if (userIds.length === 0) {
      return [];
    }
    const sumIn = (window: DepositWindow) =>
      sql<string>`coalesce(sum(${walletTransaction.amount}) filter (where ${inWindow(window)}), 0)`;
    return this.deps.drizzle.db
      .select({
        userId: wallet.userId,
        currency: walletTransaction.currency,
        depositsA: sumIn(windowA),
        depositsB: sumIn(windowB),
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(
          sql`${wallet.userId} = ANY(${sql.param([...userIds])}::uuid[])`,
          eq(walletTransaction.type, 'deposit'),
          eq(walletTransaction.status, 'completed'),
          or(inWindow(windowA), inWindow(windowB)),
        ),
      )
      .groupBy(wallet.userId, walletTransaction.currency);
  }
}
