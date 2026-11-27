import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CumulativeDepositReKycTrigger, type ReKycPlayerSnapshot } from '../re-kyc-trigger.js';

const trigger = new CumulativeDepositReKycTrigger();

const snapshot = (totalDeposits: string, lastTriggeredDeposits = '0', currency = 'USD') =>
  ({ currency, totalDeposits, lastTriggeredDeposits }) as ReKycPlayerSnapshot;

describe('CumulativeDepositReKycTrigger.requiresReverify', () => {
  it.each([
    ['one unit under the first threshold', '999.99', '0', false],
    ['exactly at the first threshold', '1000', '0', true],
    ['just over the first threshold', '1000.01', '0', true],
    ['still inside the band already fired', '1999.99', '1000', false],
    ['exactly at the second threshold', '2000', '1000', true],
    ['skipping several bands at once', '5500', '1000', true],
    ['nothing deposited since the last fire', '1500', '1500', false],
    ['no deposits at all', '0', '0', false],
  ])('%s', (_name, total, last, expected) => {
    expect(trigger.requiresReverify(snapshot(total, last), { USD: '1000' })).toBe(expected);
  });

  it.each([
    ['zero threshold', { USD: '0' }],
    ['zero with decimals', { USD: '0.000000000000000000' }],
    ['no threshold for the currency', { EUR: '1000' }],
    ['no thresholds configured', undefined],
  ])('never fires for %s', (_name, thresholds) => {
    expect(trigger.requiresReverify(snapshot('1000000', '0'), thresholds)).toBe(false);
  });

  it('reads the threshold of the player currency only', () => {
    const thresholds = { USD: '1000', BTC: '0.5' };
    expect(trigger.requiresReverify(snapshot('0.5', '0', 'BTC'), thresholds)).toBe(true);
    expect(trigger.requiresReverify(snapshot('0.5', '0', 'USD'), thresholds)).toBe(false);
  });

  it('handles 18-decimal amounts on both sides of an exact threshold', () => {
    const thresholds = { USD: '1000.000000000000000000' };
    expect(trigger.requiresReverify(snapshot('1000.000000000000000000'), thresholds)).toBe(true);
    expect(trigger.requiresReverify(snapshot('1500.123456789012345678', '1000'), thresholds)).toBe(
      false,
    );
    expect(
      trigger.requiresReverify(snapshot('2000.000000000000000000', '1500.5'), thresholds),
    ).toBe(true);
  });

  it('does not fire one minor unit below the threshold at 18 decimals', () => {
    expect(trigger.requiresReverify(snapshot('999.999999999999999999'), { USD: '1000' })).toBe(
      false,
    );
  });

  it('fires on a fractional threshold whose float division rounds down', () => {
    expect(trigger.requiresReverify(snapshot('0.3', '0.2'), { USD: '0.1' })).toBe(true);
  });

  it('fires exactly when the band index grows, for whole-unit amounts', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (threshold, total, last) => {
          const expected = Math.floor(total / threshold) > Math.floor(last / threshold);
          expect(
            trigger.requiresReverify(snapshot(String(total), String(last)), {
              USD: String(threshold),
            }),
          ).toBe(expected);
        },
      ),
    );
  });

  it('never fires when deposits have not grown past the high-water mark', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        (threshold, a, b) => {
          const [low, high] = a <= b ? [a, b] : [b, a];
          expect(
            trigger.requiresReverify(snapshot(String(low), String(high)), {
              USD: String(threshold),
            }),
          ).toBe(false);
        },
      ),
    );
  });
});
