import { describe, it, expect } from 'vitest';
import {
  FinancialSummaryQuerySchema,
  FinancialGgrQuerySchema,
  FunnelQuerySchema,
  FunnelStageSchema,
} from '../contract/index.js';

describe('analytics contract schemas', () => {
  it('defaults financial ggr granularity to day', () => {
    const parsed = FinancialGgrQuerySchema.parse({});
    expect(parsed.granularity).toBe('day');
  });

  it('accepts a financial summary query with only a currency filter', () => {
    expect(() => FinancialSummaryQuerySchema.parse({ currency: 'USD' })).not.toThrow();
  });

  it('rejects a currency that is not a 3-letter ISO code', () => {
    expect(() => FinancialSummaryQuerySchema.parse({ currency: 'us' })).toThrow();
  });

  it('accepts an empty funnel query (unranged)', () => {
    expect(() => FunnelQuerySchema.parse({})).not.toThrow();
  });

  it('rejects a funnel stage count below zero', () => {
    expect(() =>
      FunnelStageSchema.parse({ stage: 'registered', count: -1, dropOffRate: 0 }),
    ).toThrow();
  });

  it('rejects a drop-off rate outside 0..1', () => {
    expect(() =>
      FunnelStageSchema.parse({ stage: 'registered', count: 1, dropOffRate: 1.5 }),
    ).toThrow();
  });
});
