import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { moneyAdd, moneySubtract } from '@openora/core/server';
import { gateSweepBalance } from '../custody-sweep.service.js';

const U = '0.000000000000000001';

type Args = Parameters<typeof gateSweepBalance>[0];

const base: Args = {
  amount: '100',
  estimatedFee: '1',
  dustThreshold: '5',
  feeMultiple: '2',
  sweepFeeCeiling: null,
  poolLiquidityFloor: null,
  poolBalance: null,
};

const gate = (overrides: Partial<Args>) => gateSweepBalance({ ...base, ...overrides });

describe('gateSweepBalance', () => {
  it('sweeps a healthy balance', () => {
    expect(gate({})).toBe('sweep');
  });

  describe('dust boundary', () => {
    it('is dust one unit below the threshold', () => {
      expect(gate({ amount: moneySubtract('5', U) })).toBe('dust');
    });
    it('is not dust exactly at the threshold', () => {
      expect(gate({ amount: '5', dustThreshold: '5', estimatedFee: '0' })).toBe('sweep');
    });
    it('is not dust one unit above the threshold', () => {
      expect(gate({ amount: moneyAdd('5', U), estimatedFee: '0' })).toBe('sweep');
    });
    it('reports dust before fee when both apply', () => {
      expect(gate({ amount: '1', estimatedFee: '100' })).toBe('dust');
    });
  });

  describe('fee boundary (amount against fee x multiple)', () => {
    const args = { dustThreshold: '0', estimatedFee: '3', feeMultiple: '2' };
    it('fails one unit below fee x multiple', () => {
      expect(gate({ ...args, amount: moneySubtract('6', U) })).toBe('fee');
    });
    it('passes exactly at fee x multiple', () => {
      expect(gate({ ...args, amount: '6' })).toBe('sweep');
    });
    it('passes one unit above fee x multiple', () => {
      expect(gate({ ...args, amount: moneyAdd('6', U) })).toBe('sweep');
    });
    it('treats a non-integer multiple exactly', () => {
      expect(gate({ ...args, feeMultiple: '1.5', amount: '4.5' })).toBe('sweep');
      expect(gate({ ...args, feeMultiple: '1.5', amount: moneySubtract('4.5', U) })).toBe('fee');
    });
  });

  describe('ceiling boundary (fee against sweepFeeCeiling)', () => {
    const args = { amount: '1000', dustThreshold: '0', feeMultiple: '1' };
    it('sweeps with a fee one unit below the ceiling', () => {
      expect(gate({ ...args, estimatedFee: moneySubtract('3', U), sweepFeeCeiling: '3' })).toBe(
        'sweep',
      );
    });
    it('sweeps with a fee exactly at the ceiling', () => {
      expect(gate({ ...args, estimatedFee: '3', sweepFeeCeiling: '3' })).toBe('sweep');
    });
    it('refuses with a fee one unit above the ceiling', () => {
      expect(gate({ ...args, estimatedFee: moneyAdd('3', U), sweepFeeCeiling: '3' })).toBe(
        'ceiling',
      );
    });
    it('has no ceiling when null', () => {
      expect(gate({ ...args, estimatedFee: '999', sweepFeeCeiling: null })).toBe('sweep');
    });
  });

  describe('pool floor override', () => {
    const args = {
      amount: '1000',
      dustThreshold: '0',
      feeMultiple: '1',
      estimatedFee: '10',
      sweepFeeCeiling: '3',
      poolLiquidityFloor: '500',
    };
    it('overrides the ceiling one unit below the floor', () => {
      expect(gate({ ...args, poolBalance: moneySubtract('500', U) })).toBe('sweep');
    });
    it('keeps the ceiling exactly at the floor', () => {
      expect(gate({ ...args, poolBalance: '500' })).toBe('ceiling');
    });
    it('keeps the ceiling one unit above the floor', () => {
      expect(gate({ ...args, poolBalance: moneyAdd('500', U) })).toBe('ceiling');
    });
    it('keeps the ceiling when the pool balance is unknown', () => {
      expect(gate({ ...args, poolBalance: null })).toBe('ceiling');
    });
    it('keeps the ceiling when no floor is configured', () => {
      expect(gate({ ...args, poolLiquidityFloor: null, poolBalance: '0' })).toBe('ceiling');
    });
    it('never overrides dust or fee', () => {
      expect(gate({ ...args, amount: '1', dustThreshold: '5', poolBalance: '0' })).toBe('dust');
      expect(gate({ ...args, amount: '5', estimatedFee: '10', poolBalance: '0' })).toBe('fee');
    });
  });

  it('agrees with an independent reference over small integer inputs', () => {
    const n = fc.integer({ min: 0, max: 50 });
    fc.assert(
      fc.property(
        n,
        n,
        n,
        fc.integer({ min: 1, max: 4 }),
        fc.option(n, { nil: null }),
        fc.option(n, { nil: null }),
        fc.option(n, { nil: null }),
        (amount, fee, dust, multiple, ceiling, floor, pool) => {
          const expected =
            amount < dust
              ? 'dust'
              : amount < fee * multiple
                ? 'fee'
                : ceiling !== null &&
                    fee > ceiling &&
                    !(floor !== null && pool !== null && pool < floor)
                  ? 'ceiling'
                  : 'sweep';
          const actual = gateSweepBalance({
            amount: String(amount),
            estimatedFee: String(fee),
            dustThreshold: String(dust),
            feeMultiple: String(multiple),
            sweepFeeCeiling: ceiling === null ? null : String(ceiling),
            poolLiquidityFloor: floor === null ? null : String(floor),
            poolBalance: pool === null ? null : String(pool),
          });
          expect(actual).toBe(expected);
        },
      ),
    );
  });
});
