import { describe, expect, it } from 'vitest';
import { type AttributionGrant, attributeStake } from '../stake-attribution.js';

const grant = (
  id: string,
  headroom: string,
  percent: string,
  bonusStake = '0',
): AttributionGrant<string> => ({ id, headroom, percent, bonusStake });

describe('attributeStake', () => {
  it("a grant's own bonus stake progresses that grant only", () => {
    const result = attributeStake([grant('a', '100', '100', '10'), grant('b', '100', '100')], '0');
    expect(result).toEqual([
      { id: 'a', bonusStake: '10', realStake: '0', progress: '10.000000000000000000' },
      { id: 'b', bonusStake: '0', realStake: '0', progress: '0.000000000000000000' },
    ]);
  });

  it('real stake fills the first grant up to its headroom and carries the rest to the next', () => {
    const result = attributeStake([grant('a', '10', '100'), grant('b', '100', '100')], '30');
    expect(result).toEqual([
      { id: 'a', bonusStake: '0', realStake: '10.000000000000000000', progress: '10' },
      {
        id: 'b',
        bonusStake: '0',
        realStake: '20.000000000000000000',
        progress: '20.000000000000000000',
      },
    ]);
  });

  it("carried stake is weighted by the next grant's own percent", () => {
    const result = attributeStake([grant('a', '10', '100'), grant('b', '100', '50')], '30');
    expect(result).toEqual([
      { id: 'a', bonusStake: '0', realStake: '10.000000000000000000', progress: '10' },
      {
        id: 'b',
        bonusStake: '0',
        realStake: '20.000000000000000000',
        progress: '10.000000000000000000',
      },
    ]);
  });

  it("progress never exceeds a grant's headroom", () => {
    const [ownOverflow] = attributeStake([grant('a', '5', '100', '50')], '0');
    expect(ownOverflow?.progress).toBe('5');
    const result = attributeStake([grant('a', '5', '100'), grant('b', '3', '100')], '1000');
    expect(result.map((r) => r.progress)).toEqual(['5', '3']);
  });

  it('real stake no grant absorbs stays on the first grant with no progress', () => {
    const result = attributeStake([grant('a', '10', '100'), grant('b', '4', '100')], '30');
    expect(result).toEqual([
      { id: 'a', bonusStake: '0', realStake: '26.000000000000000000', progress: '10' },
      { id: 'b', bonusStake: '0', realStake: '4.000000000000000000', progress: '4' },
    ]);
    const unweighted = attributeStake([grant('a', '10', '0')], '30');
    expect(unweighted).toEqual([
      {
        id: 'a',
        bonusStake: '0',
        realStake: '30.000000000000000000',
        progress: '0.000000000000000000',
      },
    ]);
  });

  it('an empty grant list attributes nothing', () => {
    expect(attributeStake([], '50')).toEqual([]);
  });
});
