import { asc, eq } from 'drizzle-orm';
import type { AuditWritePort, Uuid } from '@openora/core/contracts';
import { createDomainError, moneyCompare, type DrizzleService } from '@openora/core/server';
import { promoRankTier, type PromoRankTier } from '../schema/index.js';
import type { RankLadder, SetRankLadderInput } from '../contract/index.js';
import { RankLadderNotConfiguredError } from './rank.service.js';

export const RankLadderMismatchError = createDomainError<[detail: string]>(
  'RankLadderMismatchError',
  (detail) => `the tiers sent do not match the ladder: ${detail}`,
);

export const RankLadderInvalidError = createDomainError<[reason: string]>(
  'RankLadderInvalidError',
  (reason) => `the ladder would be invalid: ${reason}`,
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

type LockedTier = Pick<PromoRankTier, keyof typeof TIER_COLUMNS | 'currency'>;

function assertSameTiers(locked: readonly LockedTier[], input: SetRankLadderInput) {
  const known = new Set(locked.map((tier) => tier.id));
  const sent = new Set(input.tiers.map((tier) => tier.id));
  const unknown = [...sent].filter((id) => !known.has(id));
  const missing = [...known].filter((id) => !sent.has(id));
  if (unknown.length > 0 || missing.length > 0) {
    throw new RankLadderMismatchError(
      [
        missing.length > 0 ? `missing ${missing.join(', ')}` : '',
        unknown.length > 0 ? `unknown ${unknown.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; '),
    );
  }
}

function assertLadderHolds(tiers: readonly { wagerThreshold: string }[]) {
  const [lowest, ...rest] = tiers;
  if (!lowest) {
    throw new RankLadderNotConfiguredError('default');
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
 * The operator's side of the rank ladder. Only the numbers are editable: a tier's key, name,
 * position and currency are fixed, because the player-facing surface is keyed off them.
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
    return toLadder(
      await this.drizzle.db
        .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
        .from(promoRankTier)
        .orderBy(asc(promoRankTier.position)),
    );
  }

  async set(adminId: Uuid, input: SetRankLadderInput) {
    return this.drizzle.db.transaction(async (tx) => {
      const locked = await tx
        .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
        .from(promoRankTier)
        .orderBy(asc(promoRankTier.position))
        .for('update');
      const before = toLadder(locked);

      assertSameTiers(locked, input);
      const edits = new Map(input.tiers.map((tier) => [tier.id, tier]));
      const after = locked.map((tier) => ({ ...tier, ...edits.get(tier.id) }));
      assertLadderHolds(after);

      for (const tier of after) {
        await tx.update(promoRankTier).set(editable(tier)).where(eq(promoRankTier.id, tier.id));
      }

      const ladder = toLadder(
        await tx
          .select({ ...TIER_COLUMNS, currency: promoRankTier.currency })
          .from(promoRankTier)
          .orderBy(asc(promoRankTier.position)),
      );
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
}

const editable = (tier: LockedTier) => ({
  wagerThreshold: tier.wagerThreshold,
  rakebackPercent: tier.rakebackPercent,
  dailyBonus: tier.dailyBonus,
  weeklyBonus: tier.weeklyBonus,
  monthlyBonus: tier.monthlyBonus,
  levelUpBonus: tier.levelUpBonus,
});

function toLadder(tiers: readonly LockedTier[]): RankLadder {
  const [lowest] = tiers;
  if (!lowest) {
    throw new RankLadderNotConfiguredError('default');
  }
  return {
    currency: lowest.currency,
    tiers: tiers.map(({ currency: _currency, ...tier }) => tier),
  };
}
