import { describe, it, expect } from 'vitest';
import { activeRakebackMilestone, isStreakLive } from '../shared/streak-day.js';
import {
  fixedRewardViews,
  nextMilestoneAfter,
  type StreakGrantView,
} from '../shared/streak-view.js';

const NOW = new Date('2026-03-10T12:00:00Z');

const rate = (day: number, unrankedRatePercent = '1', rankedUpliftPercent = '5') => ({
  day,
  unrankedRatePercent,
  rankedUpliftPercent,
});
const reward = (day: number, amount = '5') => ({
  day,
  amount,
  rolloverMultiplier: '10',
  claimExpiryDays: 7,
});
const grant = (overrides: Partial<StreakGrantView> = {}): StreakGrantView => ({
  id: 'grant-1',
  day: 3,
  amount: '5',
  rolloverMultiplier: '10',
  claimExpiryDays: 7,
  maxBet: null,
  reachedAt: new Date('2026-03-09T00:00:00Z'),
  settledAt: null,
  outcome: null,
  expiresAt: new Date('2026-03-16T00:00:00Z'),
  ...overrides,
});

describe('isStreakLive', () => {
  it.each([
    ['today', '2026-03-10', true],
    ['yesterday', '2026-03-09', true],
    ['two days ago', '2026-03-08', false],
    ['never', null, false],
  ])('is %s -> %s', (_label, day, live) => {
    expect(isStreakLive(day, NOW)).toBe(live);
  });

  it('judges the UTC day, not the local one', () => {
    expect(isStreakLive('2026-03-09', new Date('2026-03-10T23:59:59Z'))).toBe(true);
    expect(isStreakLive('2026-03-09', new Date('2026-03-11T00:00:00Z'))).toBe(false);
  });
});

describe('activeRakebackMilestone', () => {
  const milestones = [rate(1, '1'), rate(7, '3'), rate(14, '5')];

  it.each([
    [0, null],
    [1, 1],
    [6, 1],
    [7, 7],
    [13, 7],
    [14, 14],
    [400, 14],
  ])('at streak %s uses the row for day %s', (current, day) => {
    expect(activeRakebackMilestone(milestones, current)?.day ?? null).toBe(day);
  });

  it('is null when nothing is configured', () => {
    expect(activeRakebackMilestone([], 10)).toBeNull();
  });
});

describe('fixedRewardViews', () => {
  it('shows an unreached configured reward as locked with the config terms', () => {
    expect(fixedRewardViews([reward(3)], [], NOW)).toEqual([
      { ...reward(3), state: 'locked', grantId: null, unlockedAt: null, expiresAt: null },
    ]);
  });

  it('shows the max bet captured at unlock', () => {
    const [view] = fixedRewardViews([reward(3)], [grant({ maxBet: '2' })], NOW);
    expect(view?.maxBet).toBe('2');
  });

  it('shows an unclaimed reward inside its window as claimable, with the terms captured at unlock', () => {
    const [view] = fixedRewardViews([reward(3, '99')], [grant()], NOW);
    expect(view).toMatchObject({
      state: 'claimable',
      amount: '5',
      grantId: 'grant-1',
      unlockedAt: '2026-03-09T00:00:00.000Z',
      expiresAt: '2026-03-16T00:00:00.000Z',
    });
  });

  it('shows an unsettled reward past its window as expired even before the sweep runs', () => {
    const [view] = fixedRewardViews([reward(3)], [grant({ expiresAt: NOW })], NOW);
    expect(view?.state).toBe('expired');
  });

  it.each([
    ['granted', 'claimed'],
    ['expired', 'expired'],
    ['restricted', 'expired'],
  ] as const)('shows a settled %s reward as %s', (outcome, state) => {
    const [view] = fixedRewardViews([reward(3)], [grant({ settledAt: NOW, outcome })], NOW);
    expect(view?.state).toBe(state);
  });

  it('treats a reversed unlock as never unlocked', () => {
    const [view] = fixedRewardViews(
      [reward(3)],
      [grant({ settledAt: NOW, outcome: 'reversed' })],
      NOW,
    );
    expect(view).toMatchObject({ state: 'locked', grantId: null });
  });

  it('keeps a reward the config no longer lists, with its captured terms', () => {
    expect(fixedRewardViews([], [grant()], NOW)).toEqual([
      expect.objectContaining({ day: 3, amount: '5', state: 'claimable' }),
    ]);
  });

  it('drops a reversed unlock whose reward the config no longer lists', () => {
    expect(fixedRewardViews([], [grant({ settledAt: NOW, outcome: 'reversed' })], NOW)).toEqual([]);
  });

  it('orders the rewards by day', () => {
    const views = fixedRewardViews([reward(10), reward(3)], [grant({ day: 5 })], NOW);
    expect(views.map((view) => view.day)).toEqual([3, 5, 10]);
  });
});

describe('nextMilestoneAfter', () => {
  const base = {
    rakebackMilestones: [rate(2), rate(7)],
    fixedRewards: [reward(3), reward(7)],
    grants: [],
  };

  it('is the nearest day above the streak that earns a rate or a reward', () => {
    expect(nextMilestoneAfter({ ...base, current: 0 })).toEqual({
      day: 2,
      rakeback: rate(2),
      fixedReward: null,
    });
    expect(nextMilestoneAfter({ ...base, current: 2 })).toEqual({
      day: 3,
      rakeback: null,
      fixedReward: reward(3),
    });
  });

  it('combines a rate and a reward on the same day', () => {
    expect(nextMilestoneAfter({ ...base, current: 3 })).toEqual({
      day: 7,
      rakeback: rate(7),
      fixedReward: reward(7),
    });
  });

  it('is null once the streak is past every configured day', () => {
    expect(nextMilestoneAfter({ ...base, current: 7 })).toBeNull();
    expect(nextMilestoneAfter({ ...base, current: 90 })).toBeNull();
  });

  it('skips a reward that is already unlocked, since the day will not unlock it again', () => {
    expect(
      nextMilestoneAfter({
        ...base,
        current: 2,
        grants: [grant({ day: 3, settledAt: NOW, outcome: 'granted' })],
      }),
    ).toEqual({ day: 7, rakeback: rate(7), fixedReward: reward(7) });
  });
});
