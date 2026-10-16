import { randomInt } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type {
  BonusGrantCommands,
  DomainEventPayload,
  ExchangeRateReader,
  PlayEligibilityPort,
  Uuid,
  WalletCommands,
  WalletReader,
} from '@openora/core/contracts';
import {
  makeNotFoundError,
  moneyScaleBy,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import { promoPlayerRank, promoStreakConfig, promoStreakMilestoneGrant } from '../schema/index.js';
import type { StreakClaimResult, StreakReward } from '../contract/index.js';
import { priceForPayout } from '../shared/payout-currency.js';

type Granted = DomainEventPayload<'promo.bonus.granted'>;

/** What `plugin.ts` announces per cash reward, once the claim's transaction has committed. */
export type StreakCashPaid = {
  userId: Uuid;
  /** As actually credited, after `priceForPayout` - may differ from the streak's own currency. */
  amount: string;
  currency: string;
  /** Null on a replayed credit (the balance already moved and was already announced). */
  transactionId: string | null;
};

export type StreakClaimOutcome = StreakClaimResult & {
  granted: Granted[];
  cashPaid: StreakCashPaid[];
};

export type StreakMilestoneReached = DomainEventPayload<'promo.streak.milestone.reached'>;

export const StreakMilestoneNotClaimableError = makeNotFoundError('StreakMilestone');

const BATCH = 500;
const DAY_MS = 86_400_000;

/** A "gift drop": an amount rolled fresh at settlement, cents precision, uniform over the range. */
function rollGiftDrop(min: string, max: string): string {
  const lowCents = Math.round(Number(min) * 100);
  const highCents = Math.round(Number(max) * 100);
  const cents = highCents > lowCents ? randomInt(lowCents, highCents + 1) : lowCents;
  return (cents / 100).toFixed(2);
}

/**
 * Settles a milestone `StreakService.recordWager` recorded, when its player claims it: every
 * `bonus`/`giftDrop` reward through `BONUS_GRANTS`, every `rakebackBoost` onto the player's own
 * rank row. One milestone can carry several rewards (day 21 pays two gift drops and a fixed
 * bonus); each gets its own `sourceRef` off the milestone row's id, so a retry after a partial
 * failure never pays a reward that already landed twice.
 *
 * A player under a responsible-gambling block gets nothing settled, the same rule
 * `RankPayoutService` applies - a bonus waiting at the end of a block is an incentive to return.
 */
export class StreakPayoutService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly grants: BonusGrantCommands | undefined,
    private readonly eligibility: PlayEligibilityPort | undefined,
    private readonly rates: ExchangeRateReader,
    private readonly walletReader: WalletReader,
    private readonly payoutCurrency: string,
    private readonly wallet?: WalletCommands,
  ) {}

  /**
   * Row lock with SKIP LOCKED plus the unsettled filter make a double or parallel claim settle
   * once; the loser sees the milestone as not claimable.
   */
  async claim(userId: Uuid, milestoneGrantId: Uuid): Promise<StreakClaimOutcome> {
    if (!this.grants || !this.eligibility) {
      throw new Error('streak claim needs BONUS_GRANTS and PLAY_ELIGIBILITY bound');
    }
    return this.drizzle.db.transaction(async (tx) => {
      const [config] = await tx
        .select({ milestones: promoStreakConfig.milestones })
        .from(promoStreakConfig);
      const settled = await this.settleOne(tx, userId, milestoneGrantId, config?.milestones ?? []);
      if (!settled) {
        throw new StreakMilestoneNotClaimableError(milestoneGrantId);
      }
      return settled;
    });
  }

  /**
   * Marks unclaimed milestones nobody has been told about yet as announced and returns them. Run
   * apart from the bet that reached a milestone, so a player is never told about a reward a
   * rolled-back bet never earned.
   */
  async announceReached(): Promise<StreakMilestoneReached[]> {
    const rows = await this.drizzle.db
      .update(promoStreakMilestoneGrant)
      .set({ announcedAt: new Date() })
      .where(
        inArray(
          promoStreakMilestoneGrant.id,
          this.drizzle.db
            .select({ id: promoStreakMilestoneGrant.id })
            .from(promoStreakMilestoneGrant)
            .where(
              and(
                isNull(promoStreakMilestoneGrant.settledAt),
                isNull(promoStreakMilestoneGrant.announcedAt),
              ),
            )
            .limit(BATCH),
        ),
      )
      .returning({ userId: promoStreakMilestoneGrant.userId, day: promoStreakMilestoneGrant.day });
    return rows.map((row) => ({ ...row, grantId: null }));
  }

  private async settleOne(
    tx: DrizzleTx,
    userId: Uuid,
    id: Uuid,
    milestones: readonly { day: number; rewards: readonly StreakReward[] }[],
  ): Promise<StreakClaimOutcome | null> {
    const [row] = await tx
      .select({ day: promoStreakMilestoneGrant.day })
      .from(promoStreakMilestoneGrant)
      .where(
        and(
          eq(promoStreakMilestoneGrant.id, id),
          eq(promoStreakMilestoneGrant.userId, userId),
          isNull(promoStreakMilestoneGrant.settledAt),
        ),
      )
      .for('update', { skipLocked: true });
    if (!row) {
      return null;
    }
    const settle = (outcome: StreakClaimResult['outcome']) =>
      tx
        .update(promoStreakMilestoneGrant)
        .set({ settledAt: new Date(), outcome })
        .where(eq(promoStreakMilestoneGrant.id, id));

    if ((await this.eligibility?.isRestricted(userId, tx)) ?? true) {
      await settle('restricted');
      return { outcome: 'restricted', granted: [], cashPaid: [] };
    }
    const rewards = milestones.find((m) => m.day === row.day)?.rewards ?? [];
    const granted: Granted[] = [];
    const cashPaid: StreakCashPaid[] = [];
    for (const [index, reward] of rewards.entries()) {
      const sourceRef = `streak-milestone:${id}:${index}`;
      if (reward.kind === 'rakebackBoost') {
        await this.applyRakebackBoost(tx, userId, reward);
        continue;
      }
      if (reward.kind === 'cash') {
        cashPaid.push(await this.grantCash(tx, userId, reward, sourceRef));
        continue;
      }
      const paid = await this.grantOne(tx, userId, reward, sourceRef);
      if (paid) {
        granted.push(paid);
      }
    }
    await settle('granted');
    return { outcome: 'granted', granted, cashPaid };
  }

  private async grantOne(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'bonus' | 'giftDrop' }>,
    sourceRef: string,
  ): Promise<Granted | null> {
    if (!this.grants) {
      throw new Error('BONUS_GRANTS is not bound');
    }
    const owed = reward.kind === 'bonus' ? reward.amount : rollGiftDrop(reward.min, reward.max);
    const from = await this.currencyFor(tx);
    const currency = (await this.walletReader.getBalances(userId, tx)).activeCurrency;
    const amount = await this.inCurrency(tx, owed, from, currency);
    const maxBet =
      reward.terms.maxBet === null || reward.terms.maxBet === undefined
        ? null
        : await this.inCurrency(tx, reward.terms.maxBet, from, currency);
    const outcome = await this.grants.grant(tx, {
      userId,
      currency,
      amount,
      source: 'streak',
      sourceRef,
      actor: { type: 'system' },
      terms: {
        wageringMultiplier: reward.terms.wageringMultiplier,
        expiryDays: reward.terms.expiryDays,
        ...(maxBet === null ? {} : { maxBet }),
        ...(reward.terms.maxWinMultiplier === null || reward.terms.maxWinMultiplier === undefined
          ? {}
          : { maxWinMultiplier: reward.terms.maxWinMultiplier }),
      },
    });
    if (!outcome.ok) {
      throw new Error(`grant refused: ${outcome.reason}`);
    }
    if (!outcome.created) {
      return null;
    }
    return {
      userId,
      grantId: outcome.grantId,
      currency,
      grantedAmount: amount,
      wageringRequired: moneyScaleBy(amount, reward.terms.wageringMultiplier),
      source: 'streak',
      offerId: null,
    };
  }

  /**
   * A bonus can only be wagered by bets in the currency it was granted in, so it is granted in
   * the player's active currency. No rate throws, rolling the claim back so it can be retried.
   */
  private async inCurrency(tx: DrizzleTx, amount: string, from: string, to: string) {
    if (from === to) {
      return amount;
    }
    const converted = await this.rates.convert(amount, from, to, tx);
    if (converted === null) {
      throw new Error(`no exchange rate from ${from} to ${to} - retry once available`);
    }
    return converted;
  }

  /**
   * `cash`: real money, no bonus grant, no wagering requirement - credited through the same
   * `cashback` wallet transaction type rank rakeback uses. `sourceRef` is the milestone's own
   * `providerRefId`, so a retried claim can never pay the same milestone's cash reward twice.
   */
  private async grantCash(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'cash' }>,
    sourceRef: string,
  ): Promise<StreakCashPaid> {
    if (!this.wallet) {
      throw new Error('WALLET_COMMANDS is not bound');
    }
    const currency = await this.currencyFor(tx);
    // Never the streak's own currency unconditionally - see RacePayoutService's own use of
    // `priceForPayout` for why. Throws on no rate, rolling back the claim so it can be retried.
    const priced = await priceForPayout(
      tx,
      this.rates,
      reward.amount,
      currency,
      this.payoutCurrency,
    );
    const outcome = await this.wallet.credit(tx, {
      userId,
      amount: priced.amount,
      currency: priced.currency,
      type: 'cashback',
      allowNewCurrency: true,
      allowNewWallet: true,
      providerRef: { providerName: 'promo-streak', providerRefId: sourceRef },
    });
    if (!outcome.ok) {
      // Thrown rather than logged-and-settled-as-granted: a milestone must never settle
      // `outcome: 'granted'` for cash that never moved. See RacePayoutService for the same
      // "roll back and retry" rule.
      throw new Error(`streak cash reward failed: ${outcome.reason}`);
    }
    return {
      userId,
      amount: priced.amount,
      currency: priced.currency,
      transactionId: outcome.moved ? outcome.transactionId : null,
    };
  }

  private async currencyFor(tx: DrizzleTx) {
    const [config] = await tx
      .select({ currency: promoStreakConfig.currency })
      .from(promoStreakConfig);
    return config?.currency ?? 'USD';
  }

  /**
   * Additive on top of whatever `rakebackPercent` the player's tier already carries; there is no
   * rakeback payout engine in core yet to consume it, so this only records the boost for one to
   * read later. See the streak module's README for the deferral.
   */
  private async applyRakebackBoost(
    tx: DrizzleTx,
    userId: Uuid,
    reward: Extract<StreakReward, { kind: 'rakebackBoost' }>,
  ) {
    const expiresAt = new Date(Date.now() + reward.days * DAY_MS);
    await tx
      .update(promoPlayerRank)
      .set({ rakebackBoostPercent: reward.percentPoints, rakebackBoostExpiresAt: expiresAt })
      .where(eq(promoPlayerRank.userId, userId));
  }
}
