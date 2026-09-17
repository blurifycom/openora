import { describe, it, expect } from 'vitest';
import { countGranularityBuckets } from '../reporting.js';

const AT = (iso: string) => new Date(iso);

describe('countGranularityBuckets', () => {
  it('counts UTC days with both ends included', () => {
    expect(
      countGranularityBuckets(AT('2026-01-01T23:59:00Z'), AT('2026-01-01T23:59:59Z'), 'day'),
    ).toBe(1);
    expect(
      countGranularityBuckets(AT('2026-01-01T23:59:00Z'), AT('2026-01-02T00:00:00Z'), 'day'),
    ).toBe(2);
    expect(
      countGranularityBuckets(AT('2025-01-01T00:00:00Z'), AT('2025-12-31T00:00:00Z'), 'day'),
    ).toBe(365);
  });

  it('counts ISO weeks starting on Monday', () => {
    // 2026-01-04 is a Sunday, 2026-01-05 a Monday.
    expect(
      countGranularityBuckets(AT('2026-01-04T00:00:00Z'), AT('2026-01-05T00:00:00Z'), 'week'),
    ).toBe(2);
    expect(
      countGranularityBuckets(AT('2026-01-05T00:00:00Z'), AT('2026-01-11T23:59:59Z'), 'week'),
    ).toBe(1);
    expect(
      countGranularityBuckets(AT('2026-01-05T00:00:00Z'), AT('2026-03-29T00:00:00Z'), 'week'),
    ).toBe(12);
  });

  it('counts calendar months across a year boundary', () => {
    expect(
      countGranularityBuckets(AT('2025-12-31T00:00:00Z'), AT('2026-01-01T00:00:00Z'), 'month'),
    ).toBe(2);
    expect(
      countGranularityBuckets(AT('2026-01-01T00:00:00Z'), AT('2026-01-31T23:59:59Z'), 'month'),
    ).toBe(1);
  });
});
