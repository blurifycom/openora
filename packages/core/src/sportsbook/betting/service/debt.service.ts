import { and, asc, count, desc, eq, gt, gte, sql, type SQL } from 'drizzle-orm';
import {
  findOneOrThrow,
  isPositiveMoney,
  makeConflictError,
  makeNotFoundError,
  moneyAdd,
  moneyCompare,
  moneyEquals,
  moneySubtract,
  pageToOffset,
  uniqueConstraintName,
  type AdminCaller,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import {
  type AuditWritePort,
  type IdentityReader,
  type SportsbookDebtCause,
  type SportsbookSettleArgs,
  type Uuid,
  type WalletCommands,
  type WalletCorrectionDebitArgs,
  type WalletCorrectionDebitType,
} from '@openora/core/contracts';
import {
  SPORTSBOOK_HOLD_SOURCE,
  SPORTSBOOK_WALLET_PROVIDER_PREFIX,
  type CollectSportsbookDebtInput,
  type ListSportsbookDebtsInput,
  type SportsbookDebt,
  type SportsbookDebtAction,
  type WriteOffSportsbookDebtInput,
} from '../contract/index.js';
import {
  sportsbookBet,
  sportsbookDebtAction,
  sportsbookDebtShortfall,
  sportsbookPlayerDebt,
  type SportsbookDebtShortfallRow,
  type SportsbookPlayerDebtRow,
} from '../schema/index.js';
import { fileFinding, type SportsbookFindingArgs } from './finding.service.js';
import { lockPlayer } from './locks.service.js';

export const SportsbookDebtNotFoundError = makeNotFoundError('SportsbookDebt');
export const SportsbookDebtClearedError = makeConflictError(
  'SportsbookDebtClearedError',
  'This debt has nothing outstanding',
  { reason: 'debt_cleared' },
);
export const SportsbookDebtNothingCollectedError = makeConflictError(
  'SportsbookDebtNothingCollectedError',
  'The player balance holds nothing to collect',
  { reason: 'nothing_collected' },
);

export const SportsbookDebtIdempotencyKeyReusedError = makeConflictError(
  'SportsbookDebtIdempotencyKeyReusedError',
  'This idempotency key was already used for another debt request',
  { reason: 'idempotency_key_reused' },
);

/** An admin debt request, keyed by the caller's idempotency key. */
type DebtAction = {
  idempotencyKey: Uuid;
  action: SportsbookDebtAction;
  reason: string | null;
};

const HOLD_REASON = 'Outstanding sportsbook debt';

/** A debt change: audited and announced as `sportsbook.debt.changed` in its transaction. */
export type DebtChange = {
  before: SportsbookPlayerDebtRow | undefined;
  debt: SportsbookPlayerDebtRow;
  cause: SportsbookDebtCause;
  amount: string;
  holdActive: boolean;
  actor: AdminCaller | null;
  reason?: string;
};

export type DebtMove = { transactionId: Uuid; amount: string; type: WalletCorrectionDebitType };

export type DebtCollection = {
  change: DebtChange;
  moves: DebtMove[];
  collected: string;
  newBalance: string;
};

type CollectionSlice = Pick<WalletCorrectionDebitArgs, 'amount' | 'type' | 'providerRef'>;

/** What collections, offsets and write-offs left of each shortfall; they consume the oldest first. */
function unconsumed<T extends { amount: string }>(
  shortfalls: readonly T[],
  consumed: string,
): (T & { remaining: string })[] {
  let left = consumed;
  const rest: (T & { remaining: string })[] = [];
  for (const shortfall of shortfalls) {
    if (moneyCompare(left, shortfall.amount) >= 0) {
      left = moneySubtract(left, shortfall.amount);
      continue;
    }
    rest.push({ ...shortfall, remaining: moneySubtract(shortfall.amount, left) });
    left = '0';
  }
  return rest;
}

function toDebt(row: SportsbookPlayerDebtRow, holdActive: boolean): SportsbookDebt {
  return {
    id: row.id,
    userId: row.userId,
    currency: row.currency,
    owed: row.owed,
    collected: row.collected,
    writtenOff: row.writtenOff,
    outstanding: row.outstanding,
    status: row.status,
    holdActive,
    writtenOffBy: row.writtenOffBy,
    writtenOffReason: row.writtenOffReason,
    writtenOffAt: row.writtenOffAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function snapshot(row: SportsbookPlayerDebtRow | undefined) {
  return row
    ? {
        currency: row.currency,
        owed: row.owed,
        collected: row.collected,
        writtenOff: row.writtenOff,
        outstanding: row.outstanding,
        status: row.status,
      }
    : null;
}

const holdActiveSql = sql<boolean>`exists (
  select 1 from ${sportsbookPlayerDebt} as other
  where other.user_id = ${sportsbookPlayerDebt}.user_id and other.outstanding > 0
)`;

export type SportsbookDebtDeps = {
  drizzle: DrizzleService;
  events: EventBus;
  audit: AuditWritePort;
  identity: IdentityReader;
  wallet: WalletCommands;
};

/** Every method runs under the player lock; the caller writes the change's audit row last. */
export class SportsbookDebtService {
  private readonly drizzle: DrizzleService;
  private readonly events: EventBus;
  private readonly audit: AuditWritePort;
  private readonly identity: IdentityReader;
  private readonly wallet: WalletCommands;

  constructor(deps: SportsbookDebtDeps) {
    this.drizzle = deps.drizzle;
    this.events = deps.events;
    this.audit = deps.audit;
    this.identity = deps.identity;
    this.wallet = deps.wallet;
  }

  /** The open debt a payout in this currency offsets, locked for the rest of the transaction. */
  async lockOutstanding(
    tx: DrizzleTx,
    { userId, currency }: Pick<SportsbookPlayerDebtRow, 'userId' | 'currency'>,
  ): Promise<SportsbookPlayerDebtRow | undefined> {
    const [row] = await tx
      .select()
      .from(sportsbookPlayerDebt)
      .where(
        and(
          eq(sportsbookPlayerDebt.userId, userId),
          eq(sportsbookPlayerDebt.currency, currency),
          gt(sportsbookPlayerDebt.outstanding, '0'),
        ),
      )
      .for('update');
    return row;
  }

  /** A reopen took back less than the settlement paid: owe the rest and hold withdrawals. */
  async record(
    tx: DrizzleTx,
    {
      userId,
      currency,
      shortfall,
      betId,
      type,
      finding,
    }: Pick<SportsbookPlayerDebtRow, 'userId' | 'currency'> &
      Pick<SportsbookDebtShortfallRow, 'betId' | 'type'> & {
        shortfall: string;
        finding: SportsbookFindingArgs;
      },
  ): Promise<DebtChange> {
    const [before] = await tx
      .select()
      .from(sportsbookPlayerDebt)
      .where(
        and(eq(sportsbookPlayerDebt.userId, userId), eq(sportsbookPlayerDebt.currency, currency)),
      )
      .for('update');
    const rows = await tx
      .insert(sportsbookPlayerDebt)
      .values({ userId, currency, owed: shortfall, outstanding: shortfall, status: 'open' })
      .onConflictDoUpdate({
        target: [sportsbookPlayerDebt.userId, sportsbookPlayerDebt.currency],
        set: {
          owed: sql`${sportsbookPlayerDebt.owed} + excluded.owed`,
          outstanding: sql`${sportsbookPlayerDebt.outstanding} + excluded.outstanding`,
          status: 'open',
        },
      })
      .returning();
    const debt = findOneOrThrow(rows, new SportsbookDebtNotFoundError(userId));
    await tx
      .insert(sportsbookDebtShortfall)
      .values({ debtId: debt.id, betId, type, amount: shortfall });
    await this.wallet.placeWithdrawalHold(tx, {
      userId,
      source: SPORTSBOOK_HOLD_SOURCE,
      reason: HOLD_REASON,
    });
    await fileFinding(tx, finding);
    return {
      before,
      debt,
      cause: 'recorded',
      amount: shortfall,
      holdActive: true,
      actor: null,
    };
  }

  /**
   * Takes min(payout, outstanding) back from a payout just credited, oldest shortfall first, each in
   * its own bet's round as the type its reopen used. Null when nothing moved.
   */
  async offset(
    tx: DrizzleTx,
    debt: SportsbookPlayerDebtRow,
    {
      provider,
      payout,
      providerTxId,
    }: Pick<SportsbookSettleArgs, 'provider' | 'payout' | 'providerTxId'>,
  ): Promise<DebtCollection | null> {
    let left = payout;
    const slices: CollectionSlice[] = [];
    for (const shortfall of await this.outstandingShortfalls(tx, debt)) {
      if (!isPositiveMoney(left)) {
        break;
      }
      const amount = moneyCompare(left, shortfall.remaining) < 0 ? left : shortfall.remaining;
      left = moneySubtract(left, amount);
      slices.push({
        amount,
        type: shortfall.type,
        providerRef: {
          providerName: `${SPORTSBOOK_WALLET_PROVIDER_PREFIX}${shortfall.provider}`,
          providerRefId: `offset:${provider}:${providerTxId}:${shortfall.id}`,
          externalRoundId: shortfall.providerBetId,
        },
      });
    }
    return this.collectInto(tx, debt, { slices, cause: 'offset', actor: null });
  }

  async list({ page, limit, status, userId }: ListSportsbookDebtsInput) {
    const filters: SQL[] = [];
    if (status) {
      filters.push(eq(sportsbookPlayerDebt.status, status));
    }
    if (userId) {
      filters.push(eq(sportsbookPlayerDebt.userId, userId));
    }
    const where = filters.length > 0 ? and(...filters) : undefined;
    const [rows, [{ total }]] = await Promise.all([
      this.drizzle.db
        .select({ debt: sportsbookPlayerDebt, holdActive: holdActiveSql })
        .from(sportsbookPlayerDebt)
        .where(where)
        .orderBy(desc(sportsbookPlayerDebt.updatedAt), desc(sportsbookPlayerDebt.id))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      this.drizzle.db.select({ total: count() }).from(sportsbookPlayerDebt).where(where),
    ]);
    return {
      items: rows.map((r) => toDebt(r.debt, r.holdActive)),
      total: Number(total),
      page,
      limit,
    };
  }

  /** Admin: take what the player's real balance holds against the outstanding debt. */
  async collect(
    id: SportsbookDebt['id'],
    { idempotencyKey }: Pick<CollectSportsbookDebtInput, 'idempotencyKey'>,
    actor: AdminCaller,
  ): Promise<SportsbookDebt> {
    return this.adminChange({
      id,
      request: { idempotencyKey, action: 'collected', reason: null },
      actor,
      apply: async (tx, debt) => {
        const shortfalls = await this.outstandingShortfalls(tx, debt);
        const collection = await this.collectInto(tx, debt, {
          slices: shortfalls.map((shortfall) => ({
            amount: shortfall.remaining,
            type: shortfall.type,
            providerRef: {
              providerName: `${SPORTSBOOK_WALLET_PROVIDER_PREFIX}${shortfall.provider}`,
              providerRefId: `collect:${idempotencyKey}:${shortfall.id}`,
              externalRoundId: shortfall.providerBetId,
            },
          })),
          cause: 'collected',
          actor,
        });
        if (!collection) {
          throw new SportsbookDebtNothingCollectedError();
        }
        return { change: collection.change, moves: collection.moves };
      },
    });
  }

  /** Admin: forgive the outstanding debt. GGR keeps the original reversal; nothing reaches the ledger. */
  async writeOff(
    id: SportsbookDebt['id'],
    { reason, idempotencyKey }: Pick<WriteOffSportsbookDebtInput, 'reason' | 'idempotencyKey'>,
    actor: AdminCaller,
  ): Promise<SportsbookDebt> {
    return this.adminChange({
      id,
      request: { idempotencyKey, action: 'written_off', reason },
      actor,
      apply: async (tx, before) => {
        const rows = await tx
          .update(sportsbookPlayerDebt)
          .set({
            writtenOff: sql`${sportsbookPlayerDebt.writtenOff} + ${sportsbookPlayerDebt.outstanding}`,
            outstanding: '0',
            status: 'written_off',
            writtenOffBy: actor.userId,
            writtenOffReason: reason,
            writtenOffAt: new Date(),
          })
          .where(eq(sportsbookPlayerDebt.id, before.id))
          .returning();
        const debt = findOneOrThrow(rows, new SportsbookDebtNotFoundError(before.id));
        const change: DebtChange = {
          before,
          debt,
          cause: 'written_off',
          amount: before.outstanding,
          holdActive: await this.releaseHoldIfClear(tx, debt.userId),
          actor,
          reason,
        };
        return { change };
      },
    });
  }

  /** Writes the debt change, and the balance changes an admin collect made, to the outbox. */
  async announce(tx: DrizzleTx, change: DebtChange, moves: DebtMove[] = []): Promise<void> {
    await this.events.emitInTransaction(tx, 'sportsbook.debt.changed', {
      debtId: change.debt.id,
      userId: change.debt.userId,
      currency: change.debt.currency,
      cause: change.cause,
      amount: change.amount,
      outstanding: change.debt.outstanding,
      actorId: change.actor?.userId ?? null,
      auditRecorded: true,
    });
    if (moves.length === 0) {
      return;
    }
    const playerId = await this.identity.getPlayerIdByUserId(change.debt.userId, tx);
    for (const move of moves) {
      await this.events.emitInTransaction(tx, 'wallet.balance.changed', {
        userId: change.debt.userId,
        playerId,
        ...move,
        currency: change.debt.currency,
        direction: 'debit',
      });
    }
  }

  /**
   * Runs an admin request once per idempotency key, under the player lock. A retry with the same
   * request answers what the first answered; the key on another request is refused.
   */
  private async adminChange({
    id,
    request,
    actor,
    apply,
  }: {
    id: SportsbookDebt['id'];
    request: DebtAction;
    actor: AdminCaller;
    apply: (
      tx: DrizzleTx,
      debt: SportsbookPlayerDebtRow,
    ) => Promise<{ change: DebtChange; moves?: DebtMove[] }>;
  }): Promise<SportsbookDebt> {
    const [found] = await this.drizzle.db
      .select({ userId: sportsbookPlayerDebt.userId })
      .from(sportsbookPlayerDebt)
      .where(eq(sportsbookPlayerDebt.id, id));
    if (!found) {
      throw new SportsbookDebtNotFoundError(id);
    }
    try {
      return await this.drizzle.db.transaction(async (tx) => {
        await lockPlayer(tx, found.userId);
        const [stored] = await tx
          .select()
          .from(sportsbookDebtAction)
          .where(eq(sportsbookDebtAction.idempotencyKey, request.idempotencyKey));
        if (stored) {
          if (
            stored.debtId !== id ||
            stored.action !== request.action ||
            stored.reason !== request.reason
          ) {
            throw new SportsbookDebtIdempotencyKeyReusedError();
          }
          return stored.result;
        }
        const [debt] = await tx
          .select()
          .from(sportsbookPlayerDebt)
          .where(eq(sportsbookPlayerDebt.id, id))
          .for('update');
        if (!debt) {
          throw new SportsbookDebtNotFoundError(id);
        }
        if (moneyCompare(debt.outstanding, '0') <= 0) {
          throw new SportsbookDebtClearedError();
        }
        const { change, moves } = await apply(tx, debt);
        const result = toDebt(change.debt, change.holdActive);
        await tx.insert(sportsbookDebtAction).values({
          idempotencyKey: request.idempotencyKey,
          debtId: id,
          action: request.action,
          reason: request.reason,
          result,
          actorId: actor.userId,
        });
        await this.writeAudit(tx, change);
        await this.announce(tx, change, moves);
        return result;
      });
    } catch (err) {
      if (uniqueConstraintName(err) === 'sportsbook_debt_action_idempotency_key_unique') {
        throw new SportsbookDebtIdempotencyKeyReusedError();
      }
      throw err;
    }
  }

  /** The debt's shortfalls not yet consumed, oldest first, with the round each one owes. */
  private async outstandingShortfalls(tx: DrizzleTx, debt: SportsbookPlayerDebtRow) {
    const shortfalls = await tx
      .select({
        id: sportsbookDebtShortfall.id,
        type: sportsbookDebtShortfall.type,
        amount: sportsbookDebtShortfall.amount,
        provider: sportsbookBet.provider,
        providerBetId: sportsbookBet.providerBetId,
      })
      .from(sportsbookDebtShortfall)
      .innerJoin(sportsbookBet, eq(sportsbookBet.id, sportsbookDebtShortfall.betId))
      .where(eq(sportsbookDebtShortfall.debtId, debt.id))
      .orderBy(asc(sportsbookDebtShortfall.seq));
    const rest = unconsumed(shortfalls, moneySubtract(debt.owed, debt.outstanding));
    const total = rest.reduce((sum, shortfall) => moneyAdd(sum, shortfall.remaining), '0');
    if (!moneyEquals(total, debt.outstanding)) {
      throw new Error('sportsbook debt: its shortfalls do not add up to what is outstanding');
    }
    return rest;
  }

  /** Collects each slice in turn until the balance runs out. Null when nothing moved. */
  private async collectInto(
    tx: DrizzleTx,
    before: SportsbookPlayerDebtRow,
    {
      slices,
      cause,
      actor,
    }: {
      slices: CollectionSlice[];
      cause: 'offset' | 'collected';
      actor: AdminCaller | null;
    },
  ): Promise<DebtCollection | null> {
    const moves: DebtMove[] = [];
    let collected = '0';
    let newBalance = '0';
    for (const { amount, type, providerRef } of slices) {
      const correction = await this.wallet.correctionDebit(tx, {
        userId: before.userId,
        amount,
        currency: before.currency,
        type,
        providerRef,
      });
      newBalance = correction.newBalance;
      if (!correction.moved) {
        if (moneyCompare(correction.collected, '0') > 0) {
          throw new Error(
            'sportsbook debt: the wallet replayed a collection the debt never recorded',
          );
        }
        break;
      }
      moves.push({ transactionId: correction.transactionId, amount: correction.collected, type });
      collected = moneyAdd(collected, correction.collected);
      if (moneyCompare(correction.shortfall, '0') > 0) {
        break;
      }
    }
    if (moves.length === 0) {
      return null;
    }
    const rows = await tx
      .update(sportsbookPlayerDebt)
      .set({
        collected: sql`${sportsbookPlayerDebt.collected} + ${collected}`,
        outstanding: sql`${sportsbookPlayerDebt.outstanding} - ${collected}`,
        status: sql`case when ${sportsbookPlayerDebt.outstanding} - ${collected} = 0 then 'cleared' else 'open' end::sportsbook_debt_status`,
      })
      .where(
        and(
          eq(sportsbookPlayerDebt.id, before.id),
          gte(sportsbookPlayerDebt.outstanding, collected),
        ),
      )
      .returning();
    const debt = findOneOrThrow(rows, new SportsbookDebtNotFoundError(before.id));
    const holdActive = await this.releaseHoldIfClear(tx, debt.userId);
    return {
      change: {
        before,
        debt,
        cause,
        amount: collected,
        holdActive,
        actor,
      },
      moves,
      collected,
      newBalance,
    };
  }

  /** Releases the hold once nothing is outstanding in any currency. Returns whether it stays. */
  private async releaseHoldIfClear(
    tx: DrizzleTx,
    userId: SportsbookPlayerDebtRow['userId'],
  ): Promise<boolean> {
    if (await this.hasOutstanding(tx, userId)) {
      return true;
    }
    await this.wallet.releaseWithdrawalHold(tx, { userId, source: SPORTSBOOK_HOLD_SOURCE });
    return false;
  }

  private async hasOutstanding(
    db: DrizzleDb | DrizzleTx,
    userId: SportsbookPlayerDebtRow['userId'],
  ): Promise<boolean> {
    const rows = await db
      .select({ id: sportsbookPlayerDebt.id })
      .from(sportsbookPlayerDebt)
      .where(
        and(eq(sportsbookPlayerDebt.userId, userId), gt(sportsbookPlayerDebt.outstanding, '0')),
      )
      .limit(1);
    return rows.length > 0;
  }

  /** Inside the change's transaction, after every other write: audit_log is the last lock. */
  async writeAudit(
    tx: DrizzleTx,
    { before, debt, cause, amount, actor, reason }: DebtChange,
  ): Promise<void> {
    await this.audit.recordInTransaction(tx, {
      actorId: actor?.userId ?? null,
      actorType: actor ? 'admin' : 'system',
      action: 'sportsbook.debt.changed',
      resourceType: 'sportsbook_player_debt',
      resourceId: debt.id,
      before: snapshot(before),
      after: { ...snapshot(debt), cause, amount, ...(reason ? { reason } : {}) },
      ip: actor?.ip,
      userAgent: actor?.userAgent,
    });
  }
}
