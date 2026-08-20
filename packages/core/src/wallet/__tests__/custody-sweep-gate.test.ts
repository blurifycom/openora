import { describe, it, expect } from 'vitest';
import { gateSweepBalance } from '../service/custody-sweep.service.js';

const base = {
  amount: '100',
  estimatedFee: '1',
  minDeposit: '10',
  feeMultiple: '5',
  sweepFeeCeiling: null as string | null,
  poolLiquidityFloor: null as string | null,
  poolBalance: null as string | null,
};

describe('gateSweepBalance', () => {
  it('sweeps a balance that clears every gate', () => {
    expect(gateSweepBalance(base)).toBe('sweep');
  });

  describe('dust floor (amount >= minDeposit)', () => {
    it('skips strictly below the floor', () => {
      expect(gateSweepBalance({ ...base, amount: '9.999999999999999999' })).toBe('dust');
    });

    it('sweeps exactly at the floor', () => {
      expect(gateSweepBalance({ ...base, amount: '10' })).toBe('sweep');
    });
  });

  describe('fee-multiple floor (amount >= estimatedFee * feeMultiple)', () => {
    it('skips strictly below the floor', () => {
      // fee 1 * multiple 5 = 5; amount must be >= 5. Use 4.999... below it, but still
      // above the dust floor (10) so dust never masks this gate.
      expect(gateSweepBalance({ ...base, minDeposit: '1', amount: '4.999999999999999999' })).toBe(
        'fee',
      );
    });

    it('sweeps exactly at the floor', () => {
      expect(gateSweepBalance({ ...base, minDeposit: '1', amount: '5' })).toBe('sweep');
    });
  });

  describe('fee ceiling (skip when estimatedFee > sweepFeeCeiling)', () => {
    it('sweeps when the fee is exactly at the ceiling', () => {
      expect(gateSweepBalance({ ...base, estimatedFee: '2', sweepFeeCeiling: '2' })).toBe('sweep');
    });

    it('skips when the fee exceeds the ceiling and there is no liquidity floor', () => {
      expect(gateSweepBalance({ ...base, estimatedFee: '3', sweepFeeCeiling: '2' })).toBe(
        'ceiling',
      );
    });

    it('skips when the fee exceeds the ceiling and the pool is at or above the floor', () => {
      expect(
        gateSweepBalance({
          ...base,
          estimatedFee: '3',
          sweepFeeCeiling: '2',
          poolLiquidityFloor: '1000',
          poolBalance: '1000',
        }),
      ).toBe('ceiling');
    });

    it('overrides the ceiling only when the pool is strictly below the liquidity floor', () => {
      expect(
        gateSweepBalance({
          ...base,
          estimatedFee: '3',
          sweepFeeCeiling: '2',
          poolLiquidityFloor: '1000',
          poolBalance: '999.999999999999999999',
        }),
      ).toBe('sweep');
    });

    it('never overrides on a null poolBalance even with a floor configured', () => {
      expect(
        gateSweepBalance({
          ...base,
          estimatedFee: '3',
          sweepFeeCeiling: '2',
          poolLiquidityFloor: '1000',
          poolBalance: null,
        }),
      ).toBe('ceiling');
    });
  });
});
