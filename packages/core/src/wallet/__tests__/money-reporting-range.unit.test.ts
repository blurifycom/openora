import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveGgrRange, toBucketKey } from '../service/money-reporting.service.js';

describe('money reporting ggr window', () => {
  it('a ggr bucket key is the same for a Date and its ISO string', () => {
    const date = new Date('2026-03-15T23:59:59.999Z');
    expect(toBucketKey(date)).toBe('2026-03-15');
    expect(toBucketKey(date.toISOString())).toBe(toBucketKey(date));
  });

  describe('default window', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('an omitted date range resolves to the default window', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-03-31T12:00:00.000Z'));
      const { from, to } = resolveGgrRange();
      expect(to.toISOString()).toBe('2026-03-31T12:00:00.000Z');
      expect(from.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    });

    it('an explicit range is used as given and the window is counted back from dateTo', () => {
      const explicit = resolveGgrRange('2026-01-01T00:00:00.000Z', '2026-01-10T00:00:00.000Z');
      expect(explicit.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect(explicit.to.toISOString()).toBe('2026-01-10T00:00:00.000Z');
      const fromOmitted = resolveGgrRange(undefined, '2026-01-31T00:00:00.000Z');
      expect(fromOmitted.from.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });
  });
});
