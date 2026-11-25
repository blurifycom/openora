import { describe, it } from 'vitest';

describe('resolveContributionPercent', () => {
  it.todo('returns 0 for an unknown product even when a positive default exists');
  it.todo('returns the game row percent when a game-scoped row matches');
  it.todo('falls back to the provider row when no game row matches');
  it.todo('falls back to the product default when no narrower row matches');
  it.todo('returns 0 when no row matches and there is no default row');
  it.todo('skips a level whose reference is missing in the context');
});

describe('weightedStake', () => {
  it.todo('weights a stake at 100 percent as the full stake');
  it.todo('weights a stake at 10 percent as a tenth');
  it.todo('weights a stake at 0 percent as zero');
  it.todo('truncates a fractional result and never rounds up');
});
