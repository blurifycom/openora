import { describe, it, expect } from 'vitest';
import { moneyAdd, moneyCompare } from '@openora/core/server';
import { attributeStake as attribute, type AttributionGrant } from '../shared/stake-attribution.js';

const grant = (
  id: string,
  headroom: string,
  percent = '100',
  bonusStake = '0',
): AttributionGrant<string> => ({ id, headroom, percent, bonusStake });

const plain = (value: string) =>
  value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value;

// Money helpers answer at full scale; the cases read better in plain decimals.
const attributeStake = (grants: readonly AttributionGrant<string>[], realStake: string) =>
  attribute(grants, realStake).map((share) => ({
    ...share,
    bonusStake: plain(share.bonusStake),
    realStake: plain(share.realStake),
    progress: plain(share.progress),
  }));

const total = (values: readonly string[]) => values.reduce((sum, v) => moneyAdd(sum, v), '0');

describe('attributeStake', () => {
  it('puts the whole real stake on the first grant when it has room', () => {
    const [first, second] = attributeStake([grant('a', '100'), grant('b', '100')], '40');

    expect(first).toMatchObject({ id: 'a', realStake: '40', progress: '40' });
    expect(second).toMatchObject({ id: 'b', realStake: '0', progress: '0' });
  });

  it('fills grants in order and carries what one has no room for to the next', () => {
    const shares = attributeStake([grant('a', '30'), grant('b', '50'), grant('c', '100')], '120');

    expect(shares.map((s) => [s.realStake, s.progress])).toEqual([
      ['30', '30'],
      ['50', '50'],
      ['40', '40'],
    ]);
  });

  it('weights the carried stake by the next grant percent, not the first one', () => {
    const [first, second] = attributeStake(
      [grant('a', '20', '100'), grant('b', '100', '50')],
      '60',
    );

    expect(first).toMatchObject({ realStake: '20', progress: '20' });
    // 40 left over, counted at 50% on the second grant.
    expect(second).toMatchObject({ realStake: '40', progress: '20' });
  });

  it('spends only the stake a low-weight grant needs before carrying the rest', () => {
    const [first, second] = attributeStake([grant('a', '10', '25'), grant('b', '100')], '100');

    // 40 at 25% fills the 10 of room; the other 60 carries at full weight.
    expect(first).toMatchObject({ realStake: '40', progress: '10' });
    expect(second).toMatchObject({ realStake: '60', progress: '60' });
  });

  it('never attributes more real stake than the bet had', () => {
    const shares = attributeStake(
      [grant('a', '7', '33'), grant('b', '11', '70'), grant('c', '5', '10')],
      '50',
    );

    expect(plain(total(shares.map((s) => s.realStake)))).toBe('50');
    for (const [index, share] of shares.entries()) {
      const headroom = ['7', '11', '5'][index] ?? '0';
      expect(moneyCompare(share.progress, headroom)).toBeLessThanOrEqual(0);
    }
  });

  it('counts bonus-funded stake only on the grant whose funds paid it', () => {
    const [first, second] = attributeStake(
      [grant('a', '100', '100', '0'), grant('b', '100', '100', '30')],
      '0',
    );

    expect(first).toMatchObject({ bonusStake: '0', realStake: '0', progress: '0' });
    expect(second).toMatchObject({ bonusStake: '30', realStake: '0', progress: '30' });
  });

  it('lets real stake fill a grant behind one already advanced by its own bonus stake', () => {
    const [first, second] = attributeStake(
      [grant('a', '25', '100', '20'), grant('b', '100')],
      '15',
    );

    // Own bonus stake took 20 of 25; real stake fills the last 5 and carries 10.
    expect(first).toMatchObject({ progress: '25', realStake: '5' });
    expect(second).toMatchObject({ progress: '10', realStake: '10' });
  });

  it('caps a grant own bonus progress at its headroom without spilling it elsewhere', () => {
    const [first, second] = attributeStake([grant('a', '10', '100', '50'), grant('b', '100')], '0');

    expect(first).toMatchObject({ progress: '10' });
    expect(second).toMatchObject({ progress: '0', realStake: '0' });
  });

  it('skips a grant the product does not count for', () => {
    const [first, second] = attributeStake([grant('a', '100', '0'), grant('b', '100')], '30');

    expect(first).toMatchObject({ realStake: '0', progress: '0' });
    expect(second).toMatchObject({ realStake: '30', progress: '30' });
  });

  it('leaves real stake no requirement absorbs on the first grant without progress', () => {
    const [first, second] = attributeStake([grant('a', '10'), grant('b', '5')], '40');

    expect(first).toMatchObject({ realStake: '35', progress: '10' });
    expect(second).toMatchObject({ realStake: '5', progress: '5' });
  });

  it('gives no progress to a grant that has no requirement to meet', () => {
    const [only] = attributeStake([grant('a', '0')], '10');

    expect(only).toMatchObject({ realStake: '10', progress: '0' });
  });
});
