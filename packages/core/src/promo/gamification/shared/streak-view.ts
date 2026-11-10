import type {
  PlayerStreakFixedReward,
  StreakFixedReward,
  StreakFixedRewardState,
  StreakNextMilestone,
  StreakRakebackMilestone,
} from '../contract/index.js';
import type { PromoStreakMilestoneGrant } from '../schema/index.js';

export type StreakGrantView = Pick<
  PromoStreakMilestoneGrant,
  | 'id'
  | 'day'
  | 'amount'
  | 'rolloverMultiplier'
  | 'claimExpiryDays'
  | 'maxBet'
  | 'reachedAt'
  | 'settledAt'
  | 'outcome'
  | 'expiresAt'
>;

const SETTLED_STATES: Partial<
  Record<NonNullable<StreakGrantView['outcome']>, StreakFixedRewardState>
> = { granted: 'claimed', expired: 'expired', restricted: 'expired' };

const isUnlocked = (grant: StreakGrantView | undefined): grant is StreakGrantView =>
  grant !== undefined && grant.outcome !== 'reversed';

function stateOf(grant: StreakGrantView, now: Date): StreakFixedRewardState {
  if (grant.settledAt === null) {
    return grant.expiresAt !== null && grant.expiresAt > now ? 'claimable' : 'expired';
  }
  return (grant.outcome && SETTLED_STATES[grant.outcome]) || 'expired';
}

function capturedTerms(grant: StreakGrantView, configured: StreakFixedReward | undefined) {
  if (
    grant.amount !== null &&
    grant.rolloverMultiplier !== null &&
    grant.claimExpiryDays !== null
  ) {
    return {
      day: grant.day,
      amount: grant.amount,
      rolloverMultiplier: grant.rolloverMultiplier,
      claimExpiryDays: grant.claimExpiryDays,
      maxBet: grant.maxBet,
    };
  }
  return configured;
}

/**
 * Every fixed reward the player can see: the configured ones, plus any a player unlocked that the
 * config no longer lists. An unlocked one shows the terms captured at unlock, never the config's.
 */
export function fixedRewardViews(
  configured: readonly StreakFixedReward[],
  grants: readonly StreakGrantView[],
  now: Date,
): PlayerStreakFixedReward[] {
  const grantByDay = new Map(grants.map((grant) => [grant.day, grant]));
  const configuredByDay = new Map(configured.map((reward) => [reward.day, reward]));
  const days = [...new Set([...configuredByDay.keys(), ...grantByDay.keys()])].sort(
    (a, b) => a - b,
  );
  return days.flatMap((day): PlayerStreakFixedReward[] => {
    const grant = grantByDay.get(day);
    const reward = configuredByDay.get(day);
    if (!isUnlocked(grant)) {
      return reward
        ? [{ ...reward, state: 'locked', grantId: null, unlockedAt: null, expiresAt: null }]
        : [];
    }
    const terms = capturedTerms(grant, reward);
    return terms
      ? [
          {
            ...terms,
            state: stateOf(grant, now),
            grantId: grant.id,
            unlockedAt: grant.reachedAt.toISOString(),
            expiresAt: grant.expiresAt?.toISOString() ?? null,
          },
        ]
      : [];
  });
}

/** The nearest day above `current` that earns a rate or unlocks a reward that is not already unlocked. */
export function nextMilestoneAfter({
  current,
  rakebackMilestones,
  fixedRewards,
  grants,
}: {
  current: number;
  rakebackMilestones: readonly StreakRakebackMilestone[];
  fixedRewards: readonly StreakFixedReward[];
  grants: readonly StreakGrantView[];
}): StreakNextMilestone | null {
  const unlockedDays = new Set(grants.filter(isUnlocked).map((grant) => grant.day));
  const upcomingRewards = fixedRewards.filter((reward) => !unlockedDays.has(reward.day));
  const days = [...rakebackMilestones, ...upcomingRewards]
    .map((milestone) => milestone.day)
    .filter((day) => day > current);
  if (days.length === 0) {
    return null;
  }
  const day = Math.min(...days);
  return {
    day,
    rakeback: rakebackMilestones.find((milestone) => milestone.day === day) ?? null,
    fixedReward: upcomingRewards.find((reward) => reward.day === day) ?? null,
  };
}
