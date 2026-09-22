import { asc, eq, inArray } from 'drizzle-orm';
import type { AuditWritePort, Uuid } from '@openora/core/contracts';
import {
  createDomainError,
  makeConflictError,
  makeNotFoundError,
  moneyCompare,
  uniqueConstraintName,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  promoPlayerRank,
  promoRankConfig,
  promoRankTier,
  type PromoRankTier,
} from '../schema/index.js';
import type {
  RankConfig,
  RankLadder,
  SetRankLadderInput,
  SubmittedRankTier,
} from '../contract/index.js';
import { RankLadderNotConfiguredError } from './rank.service.js';

export const RankLadderMismatchError = createDomainError<[detail: string]>(
  'RankLadderMismatchError',
  (detail) => `the tiers sent do not match the ladder: ${detail}`,
);

export const RankLadderInvalidError = createDomainError<[reason: string]>(
  'RankLadderInvalidError',
  (reason) => `the ladder would be invalid: ${reason}`,
);

export const RankConfigNotSetError = makeNotFoundError('RankConfig');

export const RankConfigInvalidError = createDomainError<[reason: string]>(
  'RankConfigInvalidError',
  (reason) => `the rank config would be invalid: ${reason}`,
);

// The bonus engine refuses a grant above this, so a config that asks for more would be accepted
// here and then fail every payout.
const MAX_WAGERING_MULTIPLIER = '1000';

export const RankTierHeldError = makeConflictError(
  'RankTierHeldError',
  'a tier players already hold cannot be removed',
);

export const RankLadderCurrencyHeldError = makeConflictError(
  'RankLadderCurrencyHeldError',
  'the ladder currency cannot change once a player has wagered toward it',
);

export const RankTierKeyTakenError = makeConflictError(
  'RankTierKeyTakenError',
  'another tier already goes by that key',
);

const TIER_COLUMNS = {
  id: promoRankTier.id,
  key: promoRankTier.key,
  name: promoRankTier.name,
  position: promoRankTier.position,
  wagerThreshold: promoRankTier.wagerThreshold,
  rakebackPercent: promoRankTier.rakebackPercent,
  dailyBonus: promoRankTier.dailyBonus,
  weeklyBonus: promoRankTier.weeklyBonus,
  monthlyBonus: promoRankTier.monthlyBonus,
  levelUpBonus: promoRankTier.levelUpBonus,
};

type LadderRow = Pick<PromoRankTier, keyof typeof TIER_COLUMNS | 'currency'>;

function assertKnownTiers(known: ReadonlySet<string>, tiers: readonly SubmittedRankTier[]) {
  const unknown = tiers.flatMap((tier) =>
    tier.id !== undefined && !known.has(tier.id) ? [tier.id] : [],
  );
  if (unknown.length > 0) {
    throw new RankLadderMismatchError(`unknown ${unknown.join(', ')}`);
  }
}

function assertLadderHolds(tiers: readonly { wagerThreshold: string }[]) {
  const [lowest, ...rest] = tiers;
  if (!lowest) {
    throw new RankLadderInvalidError('a ladder holds at least one tier');
  }
  if (moneyCompare(lowest.wagerThreshold, '0') !== 0) {
    throw new RankLadderInvalidError(
      'the lowest tier must start at zero, so every player holds a rank',
    );
  }
  let previous = lowest;
  for (const tier of rest) {
    if (moneyCompare(tier.wagerThreshold, previous.wagerThreshold) <= 0) {
      throw new RankLadderInvalidError('each tier must ask for more than the one below it');
    }
    previous = tier;
  }
}

/**
 * The operator's side of the rank ladder: read it, and replace it as one validated set. Tiers may
 * be added, renamed, reordered and removed, because what a ladder is called and how many rungs it
 * has is an operator's decision rather than the platform's.
 *
 * Two things a ladder cannot do once players are on it, since neither can be applied backwards:
 * lose a tier somebody holds, or change the currency their lifetime wagering was counted in.
 *
 * An edit applies from the next bet onward. Raising a threshold never demotes anyone, since
 * `RankService.recordWager` only ever moves a player up.
 */
export class RankAdminService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async get() {
    const tiers = await this.drizzle.db
      .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
      .from(promoRankTier)
      .orderBy(asc(promoRankTier.position));
    const [lowest] = tiers;
    if (!lowest) {
      throw new RankLadderNotConfiguredError('default');
    }
    return toLadder(lowest.currency, tiers);
  }

  async set(adminId: Uuid, input: SetRankLadderInput) {
    return this.drizzle.db.transaction(async (tx) => {
      const locked = await tx
        .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
        .from(promoRankTier)
        .orderBy(asc(promoRankTier.position))
        .for('update');
      const [lowest] = locked;
      const before = toLadder(lowest?.currency ?? input.currency, locked);

      assertKnownTiers(new Set(locked.map((tier) => tier.id)), input.tiers);
      assertLadderHolds(input.tiers);
      if (lowest && lowest.currency !== input.currency) {
        await assertNobodyWagered(tx);
      }

      const kept = new Set(input.tiers.flatMap((tier) => (tier.id === undefined ? [] : [tier.id])));
      const removed = locked.filter((tier) => !kept.has(tier.id)).map((tier) => tier.id);
      if (removed.length > 0) {
        await assertNobodyHolds(tx, removed);
        await tx.delete(promoRankTier).where(inArray(promoRankTier.id, removed));
      }

      await writeTiers(tx, input);

      const saved = await tx
        .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
        .from(promoRankTier)
        .orderBy(asc(promoRankTier.position));
      const ladder = toLadder(input.currency, saved);
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.rank_ladder.set',
        resourceType: 'promo_rank_tier',
        resourceId: null,
        before: { tiers: before.tiers },
        after: { tiers: ladder.tiers },
      });
      return ladder;
    });
  }

  async getConfig(): Promise<RankConfig> {
    const [config] = await this.drizzle.db
      .select({
        eligibleProducts: promoRankConfig.eligibleProducts,
        rewards: promoRankConfig.rewards,
      })
      .from(promoRankConfig);
    if (!config) {
      throw new RankConfigNotSetError('global');
    }
    return config;
  }

  async setConfig(adminId: Uuid, input: RankConfig): Promise<RankConfig> {
    for (const terms of Object.values(input.rewards)) {
      if (moneyCompare(terms.wageringMultiplier, MAX_WAGERING_MULTIPLIER) > 0) {
        throw new RankConfigInvalidError(
          `a wagering multiplier is at most ${MAX_WAGERING_MULTIPLIER}`,
        );
      }
    }
    const config = {
      eligibleProducts: [...new Set(input.eligibleProducts)],
      rewards: input.rewards,
    };
    return this.drizzle.db.transaction(async (tx) => {
      const [before] = await tx
        .select({
          eligibleProducts: promoRankConfig.eligibleProducts,
          rewards: promoRankConfig.rewards,
        })
        .from(promoRankConfig)
        .for('update');
      await tx
        .insert(promoRankConfig)
        .values({ ...config, updatedBy: adminId })
        .onConflictDoUpdate({
          target: promoRankConfig.singletonKey,
          set: { ...config, updatedBy: adminId },
        });
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.rank_config.set',
        resourceType: 'promo_rank_config',
        resourceId: null,
        before: before ?? null,
        after: config,
      });
      return config;
    });
  }
}

async function assertNobodyHolds(tx: DrizzleTx, tierIds: readonly string[]) {
  const [held] = await tx
    .select({ tierId: promoPlayerRank.tierId })
    .from(promoPlayerRank)
    .where(inArray(promoPlayerRank.tierId, [...tierIds]))
    .limit(1);
  if (held) {
    throw new RankTierHeldError();
  }
}

async function assertNobodyWagered(tx: DrizzleTx) {
  const [wagered] = await tx.select({ id: promoPlayerRank.id }).from(promoPlayerRank).limit(1);
  if (wagered) {
    throw new RankLadderCurrencyHeldError();
  }
}

/**
 * Two tiers swapping keys in one save collide on the unique key: Postgres checks it per
 * statement, and the ladder is written row by row. The operator is told that rather than being
 * handed a constraint name.
 */
async function writeTiers(tx: DrizzleTx, input: SetRankLadderInput) {
  try {
    for (const [position, tier] of input.tiers.entries()) {
      const values = { ...tier, position, currency: input.currency };
      if (tier.id === undefined) {
        await tx.insert(promoRankTier).values(values);
        continue;
      }
      await tx.update(promoRankTier).set(values).where(eq(promoRankTier.id, tier.id));
    }
  } catch (err) {
    if (uniqueConstraintName(err) === null) {
      throw err;
    }
    throw new RankTierKeyTakenError();
  }
}

const toLadder = (currency: string, tiers: readonly LadderRow[]): RankLadder => ({
  currency,
  tiers: tiers.map(({ currency: _currency, ...tier }) => tier),
});
