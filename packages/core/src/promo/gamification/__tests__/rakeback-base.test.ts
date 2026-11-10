import { describe, it, expect } from 'vitest';
import { rakebackBase, rankedRakeback, unrankedRakeback } from '../service/rakeback.service.js';

describe('rakebackBase', () => {
  it('is the own-money stake itself under the stake basis, whatever the rtp', () => {
    expect(rakebackBase('100', 'stake')).toBe('100');
    expect(rakebackBase('100', 'stake', 'bogus')).toBe('100');
  });

  it('is the house edge of the stake under the margin basis', () => {
    expect(rakebackBase('100', 'margin', '0.96')).toBe('4.000000000000000000');
    expect(rakebackBase('100', 'margin', '0.99')).toBe('1.000000000000000000');
  });

  it('is zero for a game that returns the whole stake', () => {
    expect(rakebackBase('100', 'margin', '1')).toBe('0.000000000000000000');
    expect(rakebackBase('100', 'margin', '1.000')).toBe('0.000000000000000000');
  });

  it.each([
    ['missing', undefined],
    ['zero', '0'],
    ['zero with decimals', '0.000'],
    ['a percent instead of a fraction', '96'],
    ['above one', '1.01'],
    ['negative', '-0.5'],
    ['malformed', '0.9x'],
    ['too precise', '0.9999999999999999999'],
    ['empty', ''],
  ])('is zero when the rtp is %s', (_label, rtp) => {
    expect(rakebackBase('100', 'margin', rtp)).toBe('0');
  });
});

describe('rankedRakeback', () => {
  it('is the base times the rank rate when the streak adds no uplift', () => {
    expect(rankedRakeback({ base: '4', ratePercent: '5', upliftPercent: '0' })).toBe(
      '0.200000000000000000',
    );
  });

  it('multiplies the rank rate by the uplift instead of adding to it', () => {
    expect(rankedRakeback({ base: '4', ratePercent: '5', upliftPercent: '10' })).toBe(
      '0.220000000000000000',
    );
  });

  it('turns a 5 USD rakeback with a 5% uplift into 5.25, not 10.00', () => {
    expect(rankedRakeback({ base: '100', ratePercent: '5', upliftPercent: '5' })).toBe(
      '5.250000000000000000',
    );
  });

  it('truncates only at the money scale, never in an intermediate step', () => {
    expect(
      rankedRakeback({ base: '0.000000000000000003', ratePercent: '50', upliftPercent: '0' }),
    ).toBe('0.000000000000000001');
  });

  it('is zero for a zero base, a zero rate and a zero stake alike', () => {
    expect(rankedRakeback({ base: '0', ratePercent: '5', upliftPercent: '10' })).toBe(
      '0.000000000000000000',
    );
    expect(rankedRakeback({ base: '4', ratePercent: '0', upliftPercent: '10' })).toBe(
      '0.000000000000000000',
    );
  });
});

describe('unrankedRakeback', () => {
  it('pays the rate on the theoretical GGR: 2,500 at 96% rtp with 5% is 5', () => {
    expect(unrankedRakeback({ realAmount: '2500', rtp: '0.96', ratePercent: '5' })).toBe(
      '5.000000000000000000',
    );
  });

  it.each([
    ['missing', undefined],
    ['zero', '0'],
    ['a percent instead of a fraction', '96'],
    ['above one', '1.01'],
  ])('is zero when the rtp is %s', (_label, rtp) => {
    expect(unrankedRakeback({ realAmount: '2500', rtp, ratePercent: '5' })).toBe(
      '0.000000000000000000',
    );
  });

  it('is zero for a game that returns the whole stake', () => {
    expect(unrankedRakeback({ realAmount: '100', rtp: '1', ratePercent: '5' })).toBe(
      '0.000000000000000000',
    );
  });
});
