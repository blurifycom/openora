import { describe, it, expect } from 'vitest';
import { categoryRankTriggerIds } from '../game-catalog.js';

describe('categoryRankTriggerIds', () => {
  const catA = '11111111-1111-4111-8111-111111111111';
  const catB = '22222222-2222-4222-8222-222222222222';

  it('returns no categories when name, isActive, and membership are all unchanged', () => {
    const snapshot = { name: 'Roulette', isActive: true, categoryIds: [catA] };
    expect(categoryRankTriggerIds(snapshot, { ...snapshot })).toEqual([]);
  });

  it('returns the union of before/after categories when the name changed', () => {
    const before = { name: 'Roulette', isActive: true, categoryIds: [catA] };
    const after = { name: 'European Roulette', isActive: true, categoryIds: [catA] };
    expect(categoryRankTriggerIds(before, after)).toEqual([catA]);
  });

  it('returns the union of before/after categories when isActive changed', () => {
    const before = { name: 'Roulette', isActive: true, categoryIds: [catA, catB] };
    const after = { name: 'Roulette', isActive: false, categoryIds: [catA, catB] };
    expect(categoryRankTriggerIds(before, after)).toEqual(expect.arrayContaining([catA, catB]));
  });

  it('returns the union of before/after categories when membership changed', () => {
    const before = { name: 'Roulette', isActive: true, categoryIds: [catA] };
    const after = { name: 'Roulette', isActive: true, categoryIds: [catB] };
    expect(categoryRankTriggerIds(before, after)).toEqual(expect.arrayContaining([catA, catB]));
  });
});
