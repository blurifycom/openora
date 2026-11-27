import { and, asc, count, desc, eq, ne, type SQL } from 'drizzle-orm';
import type {
  IdentityReader,
  AuditWritePort,
  DomainEventPayload,
  LedgerPlayEligibilityPort,
  RgExclusionReader,
  Uuid,
  WalletCommands,
} from '@openora/core/contracts';
import {
  makeConflictError,
  makeNotFoundError,
  mapConcurrent,
  pageToOffset,
  uniqueConstraintName,
  type DrizzleService,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { promoRankPeriodicReward, type PromoRankPeriodicReward } from '../schema/index.js';
import {
  RANK_PERIODIC_REWARD_PROVIDER_NAME,
  RANK_REWARDS_CLAIMABLE_LIMIT,
  RANK_REWARDS_RECENT_LIMIT,
  type AdminRankPeriodicReward,
  type ListRankPeriodicRewardsInput,
  type RankPeriodicReward,
  type RankPeriodicRewardClaimResult,
  type RankPeriodicRewards,
} from '../contract/index.js';
import { announceCashCredit } from '../shared/cash-credit-event.js';
import {
  cashClaimBlocker,
  autoPayoutCandidates,
  isDueForAutoPayout,
  isDueForAutoPayoutLocked,
} from '../shared/cash-claim-eligibility.js';

export const RankRewardNotFoundError = makeNotFoundError('RankPeriodicReward');
export const RankRewardAlreadyClaimedError = makeConflictError(
  'RankRewardAlreadyClaimedError',
  'This reward has already been paid',
  { reason: 'already_claimed' },
);
export const RankRewardIdempotencyKeyReusedError = makeConflictError(
  'RankRewardIdempotencyKeyReusedError',
  'This idempotency key already claimed another reward',
  { reason: 'idempotency_key_reused' },
);
export const RankRewardClaimRestrictedError = makeConflictError(
  'RankRewardClaimRestrictedError',
  'Rank rewards cannot be claimed while a responsible-gambling block is active',
  { reason: 'restricted' },
);
export const RankRewardAccountBlockedError = makeConflictError(
  'RankRewardAccountBlockedError',
  'Rank rewards cannot be claimed on a suspended or closed account',
  { reason: 'account_blocked' },
);

const IDEMPOTENCY_INDEX = 'promo_rank_periodic_reward_user_id_idempotency_key_idx';
const AUTO_PAYOUT_CHECK_CONCURRENCY = 10;

type Claimed = DomainEventPayload<'promo.rank.reward.claimed'>;
type PaidOutcome = Claimed['outcome'];

type RankRewardClaimDeps = {
  drizzle: DrizzleService;
  wallet: WalletCommands | undefined;
  eligibility: LedgerPlayEligibilityPort | undefined;
  exclusions: RgExclusionReader | undefined;
  audit: AuditWritePort;
  events: EventBus;
  logger: { info: (context: object, message: string) => void };
  identity: IdentityReader;
};

const toReward = (row: PromoRankPeriodicReward): RankPeriodicReward => ({
  id: row.id,
  kind: row.kind,
  periodKey: row.periodKey,
  periodStart: row.periodStart.toISOString(),
  periodEnd: row.periodEnd.toISOString(),
  currency: row.currency,
  amount: row.amount,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
  settledAt: row.settledAt?.toISOString() ?? null,
});

const toAdminReward = (row: PromoRankPeriodicReward): AdminRankPeriodicReward => ({
  ...toReward(row),
  userId: row.userId,
  tierId: row.tierId,
  ladderCurrency: row.ladderCurrency,
  ladderAmount: row.ladderAmount,
  transactionId: row.transactionId,
});

const toResult = (row: PromoRankPeriodicReward): RankPeriodicRewardClaimResult => ({
  rewardId: row.id,
  kind: row.kind,
  currency: row.currency,
  amount: row.amount,
});

/**
 * Pays the claim-mode daily, weekly and monthly rewards `RankPayoutService` leaves, one row at a
 * time, to the real balance with no wagering. The row lock serialises two claims of one reward;
 * the loser replays when it carried the same idempotency key and is refused otherwise.
 */
export class RankRewardClaimService {
  constructor(private readonly deps: RankRewardClaimDeps) {}

  async list(userId: Uuid): Promise<RankPeriodicRewards> {
    const db = this.deps.drizzle.db;
    const [claimable, recent] = await Promise.all([
      db
        .select()
        .from(promoRankPeriodicReward)
        .where(
          and(
            eq(promoRankPeriodicReward.userId, userId),
            eq(promoRankPeriodicReward.status, 'claimable'),
          ),
        )
        .orderBy(asc(promoRankPeriodicReward.createdAt), asc(promoRankPeriodicReward.id))
        .limit(RANK_REWARDS_CLAIMABLE_LIMIT),
      db
        .select()
        .from(promoRankPeriodicReward)
        .where(
          and(
            eq(promoRankPeriodicReward.userId, userId),
            ne(promoRankPeriodicReward.status, 'claimable'),
          ),
        )
        .orderBy(desc(promoRankPeriodicReward.settledAt), desc(promoRankPeriodicReward.id))
        .limit(RANK_REWARDS_RECENT_LIMIT),
    ]);
    return {
      claimable: claimable.map(toReward),
      recent: recent.map(toReward),
      claimBlockedBy: await cashClaimBlocker(db, this.deps.eligibility, userId, { lock: false }),
    };
  }

  async claim(
    userId: Uuid,
    rewardId: Uuid,
    idempotencyKey: string,
  ): Promise<RankPeriodicRewardClaimResult> {
    try {
      return await this.deps.drizzle.db.transaction((tx) =>
        this.settleClaim(tx, userId, rewardId, idempotencyKey),
      );
    } catch (err) {
      if (uniqueConstraintName(err) === IDEMPOTENCY_INDEX) {
        throw new RankRewardIdempotencyKeyReusedError();
      }
      throw err;
    }
  }

  /**
   * Pays every reward a player left unclaimed once they can no longer claim it themselves - a
   * self-exclusion or a closed account. Pays nothing when the player is no longer due, and
   * nothing twice: a second run finds no claimable row.
   */
  async autoPay(userId: Uuid): Promise<Claimed[]> {
    return this.deps.drizzle.db.transaction(async (tx) => {
      if (
        !(await isDueForAutoPayoutLocked(tx, this.deps.eligibility, this.deps.exclusions, userId))
      ) {
        return [];
      }
      const rows = await tx
        .select()
        .from(promoRankPeriodicReward)
        .where(
          and(
            eq(promoRankPeriodicReward.userId, userId),
            eq(promoRankPeriodicReward.status, 'claimable'),
          ),
        )
        .orderBy(asc(promoRankPeriodicReward.id))
        .for('update');
      const paid: Claimed[] = [];
      for (const row of rows) {
        paid.push(await this.pay(tx, row, null, 'auto_paid'));
      }
      return paid;
    });
  }

  async dueForAutoPayout(): Promise<Uuid[]> {
    const owed = await this.deps.drizzle.db
      .selectDistinct({ userId: promoRankPeriodicReward.userId })
      .from(promoRankPeriodicReward)
      .where(eq(promoRankPeriodicReward.status, 'claimable'));
    const rows = await autoPayoutCandidates(
      this.deps.eligibility,
      owed.map((row) => row.userId),
    );
    const due = await mapConcurrent(rows, AUTO_PAYOUT_CHECK_CONCURRENCY, (row) =>
      isDueForAutoPayout(this.deps.exclusions, row.userId, row.status),
    );
    return rows.filter((_, index) => due[index]).map((row) => row.userId);
  }

  async adminList(input: ListRankPeriodicRewardsInput) {
    const conditions: SQL[] = [];
    if (input.userId) {
      conditions.push(eq(promoRankPeriodicReward.userId, input.userId));
    }
    if (input.status) {
      conditions.push(eq(promoRankPeriodicReward.status, input.status));
    }
    if (input.kind) {
      conditions.push(eq(promoRankPeriodicReward.kind, input.kind));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    const db = this.deps.drizzle.db;
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(promoRankPeriodicReward)
        .where(where)
        .orderBy(desc(promoRankPeriodicReward.createdAt), desc(promoRankPeriodicReward.id))
        .limit(input.limit)
        .offset(pageToOffset(input.page, input.limit)),
      db.select({ n: count() }).from(promoRankPeriodicReward).where(where),
    ]);
    return {
      items: rows.map(toAdminReward),
      total: Number(total?.n ?? 0),
      page: input.page,
      limit: input.limit,
    };
  }

  private async settleClaim(
    tx: DrizzleTx,
    userId: Uuid,
    rewardId: Uuid,
    idempotencyKey: string,
  ): Promise<RankPeriodicRewardClaimResult> {
    const [earlier] = await tx
      .select()
      .from(promoRankPeriodicReward)
      .where(
        and(
          eq(promoRankPeriodicReward.userId, userId),
          eq(promoRankPeriodicReward.idempotencyKey, idempotencyKey),
        ),
      );
    if (earlier) {
      if (earlier.id !== rewardId) {
        throw new RankRewardIdempotencyKeyReusedError();
      }
      return toResult(earlier);
    }
    await this.assertMayClaim(tx, userId);
    const [row] = await tx
      .select()
      .from(promoRankPeriodicReward)
      .where(
        and(eq(promoRankPeriodicReward.id, rewardId), eq(promoRankPeriodicReward.userId, userId)),
      )
      .for('update');
    if (!row) {
      throw new RankRewardNotFoundError(rewardId);
    }
    if (row.status !== 'claimable') {
      if (row.idempotencyKey === idempotencyKey) {
        return toResult(row);
      }
      throw new RankRewardAlreadyClaimedError();
    }
    await this.pay(tx, row, idempotencyKey, 'claimed');
    return toResult(row);
  }

  private async pay(
    tx: DrizzleTx,
    row: PromoRankPeriodicReward,
    idempotencyKey: string | null,
    outcome: PaidOutcome,
  ): Promise<Claimed> {
    const wallet = this.deps.wallet;
    if (!wallet) {
      throw new Error('rank reward claim needs WALLET_COMMANDS bound');
    }
    const credited = await wallet.credit(tx, {
      userId: row.userId,
      amount: row.amount,
      currency: row.currency,
      type: 'cashback',
      allowNewWallet: true,
      allowNewCurrency: true,
      providerRef: {
        providerName: RANK_PERIODIC_REWARD_PROVIDER_NAME,
        providerRefId: row.id,
        responseSnapshot: { rewardId: row.id },
      },
    });
    if (!credited.ok || !credited.moved) {
      throw new Error(
        `rank reward credit failed: ${credited.ok ? 'already credited' : credited.reason}`,
      );
    }
    const [flipped] = await tx
      .update(promoRankPeriodicReward)
      .set({
        status: outcome,
        idempotencyKey,
        transactionId: credited.transactionId,
        settledAt: new Date(),
      })
      .where(
        and(
          eq(promoRankPeriodicReward.id, row.id),
          eq(promoRankPeriodicReward.status, 'claimable'),
        ),
      )
      .returning({ id: promoRankPeriodicReward.id });
    if (!flipped) {
      throw new RankRewardAlreadyClaimedError();
    }
    const claimed = outcome === 'claimed';
    await this.deps.audit.recordInTransaction(tx, {
      // No player profile: keep the user id so a player entry always has an actor.
      actorId: claimed
        ? ((await this.deps.identity.getPlayerIdByUserId(row.userId, tx)) ?? row.userId)
        : null,
      actorType: claimed ? 'player' : 'system',
      action: claimed ? 'promo.rank_reward.claimed' : 'promo.rank_reward.auto_paid',
      resourceType: 'promo_rank_periodic_reward',
      resourceId: row.id,
      before: { status: 'claimable' },
      after: {
        status: outcome,
        userId: row.userId,
        kind: row.kind,
        periodKey: row.periodKey,
        currency: row.currency,
        amount: row.amount,
        transactionId: credited.transactionId,
      },
    });
    await announceCashCredit(tx, this.deps, {
      userId: row.userId,
      amount: row.amount,
      currency: row.currency,
      transactionId: credited.transactionId,
    });
    const payload: Claimed = {
      userId: row.userId,
      rewardId: row.id,
      kind: row.kind,
      currency: row.currency,
      amount: row.amount,
      transactionId: credited.transactionId,
      outcome,
    };
    await this.deps.events.emitInTransaction(tx, 'promo.rank.reward.claimed', payload);
    this.deps.logger.info({ ...payload }, 'rank reward paid');
    return payload;
  }

  private async assertMayClaim(tx: DrizzleTx, userId: Uuid) {
    if (!this.deps.eligibility) {
      throw new Error('rank reward claim needs PLAY_ELIGIBILITY bound');
    }
    const blocker = await cashClaimBlocker(tx, this.deps.eligibility, userId, { lock: true });
    if (blocker === 'restricted') {
      throw new RankRewardClaimRestrictedError();
    }
    if (blocker === 'account_blocked') {
      throw new RankRewardAccountBlockedError();
    }
  }
}
