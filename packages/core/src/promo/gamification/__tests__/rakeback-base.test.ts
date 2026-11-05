import { describe, it, expect } from 'vitest';
import { rakebackBase } from '../service/rakeback.service.js';

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
