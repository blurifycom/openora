import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type {
  AuditWritePort,
  BonusGrantCommands,
  DomainEventPayload,
  ExchangeRateReader,
  PlayEligibilityPort,
  Uuid,
  WalletReader,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyScaleBy,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import { promoStreakMilestoneGrant } from '../schema/index.js';
import {
  STREAK_CURRENCY,
  type StreakClaimResult,
  type StreakForfeitReason,
} from '../contract/index.js';
import { priceForPayout } from '../shared/payout-currency.js';

type Granted = DomainEventPayload<'promo.bonus.granted'>;

export type StreakClaimOutcome = StreakClaimResult & {
  granted: Granted[];
};

export type StreakMilestoneReached = DomainEventPayload<'promo.streak.milestone.reached'>;

export const StreakMilestoneNotClaimableError = makeNotFoundError('StreakMilestone');

type Logger = { error: (context: object, message: string) => void };

export type StreakPayoutDeps = {
  drizzle: DrizzleService;
  grants: BonusGrantCommands | undefined;
  eligibility: PlayEligibilityPort | undefined;
  rates: ExchangeRateReader;
  walletReader: WalletReader;
  audit: AuditWritePort;
  logger: Logger;
};

/** Who started the block: null when no person did (a rule), so the audit row names the system. */
export type StreakForfeitActor = { id: Uuid; isAdmin: boolean } | null;

const BATCH = 500;

/**
 * Settles a fixed reward `StreakService.recordWager` unlocked, when its player claims it: a bonus
 * through `BONUS_GRANTS`, priced from the reward's USD amount into the currency the player plays
 * in, under the rollover and expiry window captured at unlock. The reward row is the whole source
 * of truth; the live streak config is never read, so an edit to it cannot change a reward already
 * held. A claim after `expiresAt` is refused, and `expireDue` settles the rows nobody claimed.
 *
 * A player under a responsible-gambling block gets nothing settled, the same rule
 * `RankPayoutService` applies - a bonus waiting at the end of a block is an incentive to return.
 */
export class StreakPayoutService {
  private readonly drizzle: DrizzleService;
  private readonly grants: BonusGrantCommands | undefined;
  private readonly eligibility: PlayEligibilityPort | undefined;
  private readonly rates: ExchangeRateReader;
  private readonly walletReader: WalletReader;
  private readonly audit: AuditWritePort;
  private readonly logger: Logger;

  constructor(deps: StreakPayoutDeps) {
    this.drizzle = deps.drizzle;
    this.grants = deps.grants;
    this.eligibility = deps.eligibility;
    this.rates = deps.rates;
    this.walletReader = deps.walletReader;
    this.audit = deps.audit;
    this.logger = deps.logger;
  }

  /**
   * Row lock with SKIP LOCKED plus the unsettled and unexpired filters make a double or parallel
   * claim settle once; the loser sees the reward as not claimable.
   */
  async claim(userId: Uuid, milestoneGrantId: Uuid): Promise<StreakClaimOutcome> {
    if (!this.grants || !this.eligibility) {
      throw new Error('streak claim needs BONUS_GRANTS and PLAY_ELIGIBILITY bound');
    }
    return this.drizzle.db.transaction(async (tx) => {
      const settled = await this.settleOne(tx, userId, milestoneGrantId);
      if (!settled) {
        throw new StreakMilestoneNotClaimableError(milestoneGrantId);
      }
      return settled;
    });
  }

  /**
   * Settles every reward whose claim window has closed as `expired`, with one audit row each in
   * the same transaction. The `settledAt is null` claim makes a repeated run write nothing twice.
   * A row from before the window was captured has no expiry and can never be claimed, so it is
   * swept too.
   */
  async expireDue(now: Date): Promise<number> {
    let expired = 0;
    for (;;) {
      const batch = await this.drizzle.db.transaction(async (tx) => {
        const due = await tx
          .select({
            id: promoStreakMilestoneGrant.id,
            userId: promoStreakMilestoneGrant.userId,
            day: promoStreakMilestoneGrant.day,
            reachedAt: promoStreakMilestoneGrant.reachedAt,
            expiresAt: promoStreakMilestoneGrant.expiresAt,
          })
          .from(promoStreakMilestoneGrant)
          .where(
            and(
              isNull(promoStreakMilestoneGrant.settledAt),
              or(
                isNull(promoStreakMilestoneGrant.expiresAt),
                lte(promoStreakMilestoneGrant.expiresAt, now),
              ),
            ),
          )
          .orderBy(asc(promoStreakMilestoneGrant.reachedAt))
          .limit(BATCH)
          .for('update', { skipLocked: true });
        await tx
          .update(promoStreakMilestoneGrant)
          .set({ settledAt: now, outcome: 'expired' })
          .where(
            inArray(
              promoStreakMilestoneGrant.id,
              due.map((row) => row.id),
            ),
          );
        await this.audit.recordManyInTransaction(
          tx,
          due.map((row) => ({
            actorType: 'system' as const,
            action: 'promo.streak.milestone.expired',
            resourceType: 'promo_streak_milestone_grant',
            resourceId: row.id,
            before: { settledAt: null, outcome: null },
            after: {
              userId: row.userId,
              day: row.day,
              reachedAt: row.reachedAt.toISOString(),
              expiresAt: row.expiresAt?.toISOString() ?? null,
              outcome: 'expired',
            },
          })),
        );
        return due.length;
      });
      expired += batch;
      if (batch < BATCH) {
        return expired;
      }
    }
  }

  /**
   * Marks unclaimed rewards nobody has been told about yet as announced, handing each to
   * `announce` once its own transaction has committed. A reward whose claim window has closed is
   * skipped. `recordWager` inserts the reward inside
   * the bet's own transaction, which has no after-commit hook, so the announcement is read back
   * from committed rows instead. A row that fails is logged and left for the next tick without
   * holding back the rest of the batch. A player under a responsible-gambling block is not invited
   * to claim: the milestone is settled `restricted`, the same outcome a claim would get.
   */
  async announceReached(announce: (reached: StreakMilestoneReached) => void): Promise<void> {
    if (!this.eligibility) {
      return;
    }
    const eligibility = this.eligibility;
    const pending = await this.drizzle.db
      .select({ id: promoStreakMilestoneGrant.id })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          isNull(promoStreakMilestoneGrant.settledAt),
          isNull(promoStreakMilestoneGrant.announcedAt),
          gt(promoStreakMilestoneGrant.expiresAt, new Date()),
        ),
      )
      .orderBy(asc(promoStreakMilestoneGrant.reachedAt))
      .limit(BATCH);
    for (const { id } of pending) {
      const reached = await this.drizzle.db
        .transaction((tx) => this.announceOne(tx, id, eligibility))
        .catch((err: unknown) => {
          this.logger.error({ err, milestoneGrantId: id }, 'streak milestone announcement failed');
          return null;
        });
      if (reached) {
        announce(reached);
      }
    }
  }

  /**
   * Settles every reward a player has not claimed as `restricted` when a responsible-gambling
   * block starts, the same rule that forfeits their active bonuses, with one audit row per reward
   * in the same transaction. The `settledAt is null` claim makes a retried job write nothing twice.
   */
  async forfeitUnclaimed({
    userId,
    reason,
    actor,
  }: {
    userId: Uuid;
    reason: StreakForfeitReason;
    actor: StreakForfeitActor;
  }): Promise<number> {
    return this.drizzle.db.transaction(async (tx) => {
      const forfeited = await tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: new Date(), outcome: 'restricted' })
        .where(
          and(
            eq(promoStreakMilestoneGrant.userId, userId),
            isNull(promoStreakMilestoneGrant.settledAt),
          ),
        )
        .returning({
          id: promoStreakMilestoneGrant.id,
          day: promoStreakMilestoneGrant.day,
          reachedAt: promoStreakMilestoneGrant.reachedAt,
        });
      await this.audit.recordManyInTransaction(
        tx,
        forfeited.map((row) => ({
          ...(actor === null
            ? { actorType: 'system' as const }
            : {
                actorType: actor.isAdmin ? ('admin' as const) : ('player' as const),
                actorId: actor.id,
              }),
          action: 'promo.streak.milestone.forfeited',
          resourceType: 'promo_streak_milestone_grant',
          resourceId: row.id,
          before: { settledAt: null, outcome: null },
          after: {
            userId,
            day: row.day,
            reachedAt: row.reachedAt.toISOString(),
            outcome: 'restricted',
            reason,
          },
        })),
      );
      return forfeited.length;
    });
  }

  private async announceOne(
    tx: DrizzleTx,
    id: Uuid,
    eligibility: PlayEligibilityPort,
  ): Promise<StreakMilestoneReached | null> {
    const [row] = await tx
      .select({
        userId: promoStreakMilestoneGrant.userId,
        day: promoStreakMilestoneGrant.day,
        amount: promoStreakMilestoneGrant.amount,
      })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          eq(promoStreakMilestoneGrant.id, id),
          isNull(promoStreakMilestoneGrant.settledAt),
          isNull(promoStreakMilestoneGrant.announcedAt),
          gt(promoStreakMilestoneGrant.expiresAt, new Date()),
        ),
      )
      .for('update', { skipLocked: true });
    if (!row || row.amount === null) {
      return null;
    }
    const restricted = await eligibility.isRestricted(row.userId, tx);
    await tx
      .update(promoStreakMilestoneGrant)
      .set(
        restricted ? { settledAt: new Date(), outcome: 'restricted' } : { announcedAt: new Date() },
      )
      .where(eq(promoStreakMilestoneGrant.id, id));
    if (restricted) {
      await this.audit.recordInTransaction(tx, {
        actorType: 'system',
        action: 'promo.streak.milestone.claimed',
        resourceType: 'promo_streak_milestone_grant',
        resourceId: id,
        before: { settledAt: null, outcome: null },
        after: { userId: row.userId, day: row.day, outcome: 'restricted' },
      });
    }
    return restricted ? null : { ...row, amount: row.amount, grantId: null };
  }

  private async settleOne(
    tx: DrizzleTx,
    userId: Uuid,
    id: Uuid,
  ): Promise<StreakClaimOutcome | null> {
    const [row] = await tx
      .select({
        day: promoStreakMilestoneGrant.day,
        reachedAt: promoStreakMilestoneGrant.reachedAt,
        amount: promoStreakMilestoneGrant.amount,
        rolloverMultiplier: promoStreakMilestoneGrant.rolloverMultiplier,
        claimExpiryDays: promoStreakMilestoneGrant.claimExpiryDays,
      })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          eq(promoStreakMilestoneGrant.id, id),
          eq(promoStreakMilestoneGrant.userId, userId),
          isNull(promoStreakMilestoneGrant.settledAt),
          gt(promoStreakMilestoneGrant.expiresAt, new Date()),
        ),
      )
      .for('update', { skipLocked: true });
    if (
      !row ||
      row.amount === null ||
      row.rolloverMultiplier === null ||
      row.claimExpiryDays === null
    ) {
      return null;
    }
    const reward = {
      amount: row.amount,
      rolloverMultiplier: row.rolloverMultiplier,
      claimExpiryDays: row.claimExpiryDays,
    };
    const settle = async (outcome: StreakClaimResult['outcome'], grantIds: Uuid[]) => {
      await tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: new Date(), outcome })
        .where(eq(promoStreakMilestoneGrant.id, id));
      await this.audit.recordInTransaction(tx, {
        actorType: 'player',
        actorId: userId,
        action: 'promo.streak.milestone.claimed',
        resourceType: 'promo_streak_milestone_grant',
        resourceId: id,
        before: { settledAt: null, outcome: null },
        after: {
          userId,
          day: row.day,
          reachedAt: row.reachedAt.toISOString(),
          outcome,
          grantIds,
          ...reward,
        },
      });
    };

    if ((await this.eligibility?.isRestricted(userId, tx)) ?? true) {
      await settle('restricted', []);
      return { outcome: 'restricted', granted: [] };
    }
    // A settled row is never reactivated except after a same-day reversal, so the reach time
    // keeps a re-unlocked reward's credit apart from the reversed one's.
    const granted = await this.grantOne(tx, {
      userId,
      reward,
      sourceRef: `streak-milestone:${id}:${row.reachedAt.getTime()}:0`,
    });
    await settle('granted', [granted.grantId]);
    return { outcome: 'granted', granted: [granted] };
  }

  private async grantOne(
    tx: DrizzleTx,
    {
      userId,
      reward,
      sourceRef,
    }: {
      userId: Uuid;
      reward: { amount: string; rolloverMultiplier: string; claimExpiryDays: number };
      sourceRef: string;
    },
  ): Promise<Granted> {
    if (!this.grants) {
      throw new Error('BONUS_GRANTS is not bound');
    }
    // A bonus can only be wagered by bets in the currency it was granted in. No rate throws,
    // rolling the claim back so the reward stays claimable.
    const currency = (await this.walletReader.getBalances(userId, tx)).activeCurrency;
    const { amount } = await priceForPayout(
      tx,
      this.rates,
      reward.amount,
      STREAK_CURRENCY,
      currency,
    );
    const outcome = await this.grants.grant(tx, {
      userId,
      currency,
      amount,
      source: 'streak',
      sourceRef,
      actor: { type: 'system' },
      terms: {
        wageringMultiplier: reward.rolloverMultiplier,
        expiryDays: reward.claimExpiryDays,
      },
    });
    if (!outcome.ok) {
      throw new Error(`grant refused: ${outcome.reason}`);
    }
    if (!outcome.created) {
      throw new Error(`streak bonus ${sourceRef} was already granted`);
    }
    return {
      userId,
      grantId: outcome.grantId,
      currency,
      grantedAmount: amount,
      wageringRequired: moneyScaleBy(amount, reward.rolloverMultiplier),
      source: 'streak',
      offerId: null,
    };
  }
}
