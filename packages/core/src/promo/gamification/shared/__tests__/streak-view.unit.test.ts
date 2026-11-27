import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { fixedRewardViews, nextMilestoneAfter, type StreakGrantView } from '../streak-view.js';

type Reward = Parameters<typeof fixedRewardViews>[0][number];
type Milestone = Parameters<typeof nextMilestoneAfter>[0]['rakebackMilestones'][number];

const NOW = new Date('2026-03-10T12:00:00.000Z');
const plus = (ms: number) => new Date(NOW.getTime() + ms);

const reward = (over: Partial<Reward>): Reward => ({
  day: 3,
  amount: '10',
  rolloverMultiplier: '5',
  claimExpiryDays: 7,
  maxBet: null,
  ...over,
});

const grant = (over: Partial<StreakGrantView>): StreakGrantView => ({
  id: '66666666-6666-4666-8666-666666666666',
  day: 3,
  amount: '10',
  rolloverMultiplier: '5',
  claimExpiryDays: 7,
  maxBet: null,
  reachedAt: new Date('2026-03-09T00:00:00.000Z'),
  settledAt: null,
  outcome: null,
  expiresAt: plus(60_000),
  ...over,
});

const milestone = (day: number): Milestone => ({
  day,
  unrankedRatePercent: '1',
  rankedUpliftPercent: '10',
});

describe('fixedRewardViews', () => {
  it('shows a configured reward with no grant as locked', () => {
    expect(fixedRewardViews([reward({})], [], NOW)).toEqual([
      { ...reward({}), state: 'locked', grantId: null, unlockedAt: null, expiresAt: null },
    ]);
  });

  it('shows a reversed grant as locked under the configured terms', () => {
    const [view] = fixedRewardViews(
      [reward({})],
      [grant({ outcome: 'reversed', settledAt: NOW })],
      NOW,
    );
    expect(view?.state).toBe('locked');
    expect(view?.grantId).toBeNull();
  });

  it('drops a reversed grant whose day the config no longer lists', () => {
    expect(fixedRewardViews([], [grant({ outcome: 'reversed', settledAt: NOW })], NOW)).toEqual([]);
  });

  it.each([
    ['unsettled and before expiry', grant({ expiresAt: plus(1) }), 'claimable'],
    ['unsettled at expiry to the millisecond', grant({ expiresAt: NOW }), 'expired'],
    ['unsettled after expiry', grant({ expiresAt: plus(-1) }), 'expired'],
    ['unsettled with no expiry', grant({ expiresAt: null }), 'expired'],
    ['granted', grant({ settledAt: NOW, outcome: 'granted' }), 'claimed'],
    ['expired', grant({ settledAt: NOW, outcome: 'expired' }), 'expired'],
    ['restricted', grant({ settledAt: NOW, outcome: 'restricted' }), 'expired'],
    ['settled with no outcome', grant({ settledAt: NOW, outcome: null }), 'expired'],
    [
      'granted but still before expiry',
      grant({ settledAt: NOW, outcome: 'granted', expiresAt: plus(1) }),
      'claimed',
    ],
  ] as const)('a grant %s is %s', (_name, unlocked, state) => {
    expect(fixedRewardViews([reward({})], [unlocked], NOW)[0]?.state).toBe(state);
  });

  it('shows the terms captured at unlock, never a later edit of the config', () => {
    const [view] = fixedRewardViews(
      [reward({ amount: '1000', rolloverMultiplier: '1', claimExpiryDays: 30, maxBet: '500' })],
      [grant({ maxBet: '2' })],
      NOW,
    );
    expect(view).toMatchObject({
      amount: '10',
      rolloverMultiplier: '5',
      claimExpiryDays: 7,
      maxBet: '2',
    });
  });

  it('keeps an unlocked reward the config no longer lists', () => {
    const [view] = fixedRewardViews([], [grant({ day: 9 })], NOW);
    expect(view).toMatchObject({ day: 9, amount: '10', state: 'claimable' });
  });

  it('falls back to the configured terms when the grant captured none', () => {
    const [view] = fixedRewardViews(
      [reward({ amount: '20' })],
      [grant({ amount: null, rolloverMultiplier: null, claimExpiryDays: null })],
      NOW,
    );
    expect(view).toMatchObject({ amount: '20', state: 'claimable' });
  });

  it('drops an unlocked grant that captured no terms and is no longer configured', () => {
    expect(fixedRewardViews([], [grant({ amount: null })], NOW)).toEqual([]);
  });

  it('serialises unlock and expiry as ISO strings', () => {
    const [view] = fixedRewardViews([reward({})], [grant({})], NOW);
    expect(view?.unlockedAt).toBe('2026-03-09T00:00:00.000Z');
    expect(view?.expiresAt).toBe(plus(60_000).toISOString());
  });

  it('lists each day once, ascending, whatever the input order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 1, max: 365 }), { maxLength: 15 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 365 }), { maxLength: 15 }),
        (configuredDays, grantDays) => {
          const views = fixedRewardViews(
            configuredDays.map((day) => reward({ day })),
            grantDays.map((day) => grant({ day })),
            NOW,
          );
          const days = views.map((view) => view.day);
          expect(days).toEqual(
            [...new Set([...configuredDays, ...grantDays])].sort((a, b) => a - b),
          );
        },
      ),
    );
  });
});

describe('nextMilestoneAfter', () => {
  it('is null when nothing lies ahead', () => {
    expect(
      nextMilestoneAfter({
        current: 10,
        rakebackMilestones: [milestone(10)],
        fixedRewards: [reward({ day: 5 })],
        grants: [],
      }),
    ).toBeNull();
  });

  it('skips the day the player is on', () => {
    expect(
      nextMilestoneAfter({
        current: 3,
        rakebackMilestones: [milestone(3), milestone(7)],
        fixedRewards: [],
        grants: [],
      })?.day,
    ).toBe(7);
  });

  it('picks the nearest day whatever the config order', () => {
    expect(
      nextMilestoneAfter({
        current: 0,
        rakebackMilestones: [milestone(9), milestone(4)],
        fixedRewards: [reward({ day: 6 }), reward({ day: 2 })],
        grants: [],
      }),
    ).toEqual({ day: 2, rakeback: null, fixedReward: reward({ day: 2 }) });
  });

  it('returns both a rate and a reward that share the day', () => {
    expect(
      nextMilestoneAfter({
        current: 1,
        rakebackMilestones: [milestone(3)],
        fixedRewards: [reward({ day: 3 })],
        grants: [],
      }),
    ).toEqual({ day: 3, rakeback: milestone(3), fixedReward: reward({ day: 3 }) });
  });

  it('skips a reward already unlocked, so it is not promised twice', () => {
    expect(
      nextMilestoneAfter({
        current: 1,
        rakebackMilestones: [],
        fixedRewards: [reward({ day: 3 }), reward({ day: 5 })],
        grants: [grant({ day: 3 })],
      })?.day,
    ).toBe(5);
  });

  it('offers a reward again once its unlock was reversed', () => {
    expect(
      nextMilestoneAfter({
        current: 1,
        rakebackMilestones: [],
        fixedRewards: [reward({ day: 3 })],
        grants: [grant({ day: 3, outcome: 'reversed', settledAt: NOW })],
      })?.fixedReward,
    ).toEqual(reward({ day: 3 }));
  });

  it('still shows the rate on a day whose reward is already unlocked', () => {
    expect(
      nextMilestoneAfter({
        current: 1,
        rakebackMilestones: [milestone(3)],
        fixedRewards: [reward({ day: 3 })],
        grants: [grant({ day: 3 })],
      }),
    ).toEqual({ day: 3, rakeback: milestone(3), fixedReward: null });
  });

  it('is always the smallest qualifying day above current', () => {
    fc.assert(
      fc.property(
        fc.nat(400),
        fc.uniqueArray(fc.integer({ min: 1, max: 365 }), { maxLength: 10 }),
        fc.uniqueArray(fc.integer({ min: 1, max: 365 }), { maxLength: 10 }),
        (current, rateDays, rewardDays) => {
          const next = nextMilestoneAfter({
            current,
            rakebackMilestones: rateDays.map(milestone),
            fixedRewards: rewardDays.map((day) => reward({ day })),
            grants: [],
          });
          const ahead = [...rateDays, ...rewardDays].filter((day) => day > current);
          expect(next?.day ?? null).toBe(ahead.length === 0 ? null : Math.min(...ahead));
        },
      ),
    );
  });
});
