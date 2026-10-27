import { describe, it, expect } from 'vitest';
import type { SupportHistoryEmailWindow } from '@openora/core/contracts';
import { buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

// Seeded, so a failure replays.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};

describe('buildEmailWindows against corrupted change times', () => {
  it('answers no window wider than the truth, and the whole truth only when complete', () => {
    const random = rng(20260102);
    const pick = (n: number) => Math.floor(random() * n);
    for (let trial = 0; trial < 5000; trial++) {
      const count = 1 + pick(6);
      const email = (i: number) => `e${i}@example.test`;
      // The true change on day 10 * (i + 1); some rows are stamped wrong instead: at or before
      // the row before them, or at or before registration for the first. A wrong time that still
      // runs forward cannot be noticed by anyone, so it is not generated.
      const days: number[] = [];
      for (let i = 0; i < count; i++) {
        days.push(random() < 0.3 ? (days[i - 1] ?? 0) - pick(3) : 10 * (i + 1));
      }
      const wrong = days.some((d, i) => d !== 10 * (i + 1));
      const truth: SupportHistoryEmailWindow[] = days.map((_, i) => ({
        email: email(i),
        from: (i === 0 ? REGISTERED : day(10 * i)).toISOString(),
        to: day(10 * (i + 1)).toISOString(),
      }));
      truth.push({ email: email(count), from: day(10 * count).toISOString(), to: null });
      const held = new Map(truth.map((w) => [w.email, w]));

      const result = buildEmailWindows({
        currentEmail: email(count),
        registeredAt: REGISTERED,
        changes: days.map((d, i) => ({
          before: email(i),
          after: email(i + 1),
          at: day(d),
          timedByChange: false,
        })),
      });

      const note = JSON.stringify({ trial, days, result });
      for (const w of result.windows) {
        const span = held.get(w.email)!;
        expect(Date.parse(w.from), note).toBeGreaterThanOrEqual(Date.parse(span.from));
        expect(w.to === null ? Infinity : Date.parse(w.to), note).toBeLessThanOrEqual(
          span.to === null ? Infinity : Date.parse(span.to),
        );
      }
      expect(result.broken, note).toBe(wrong);
      expect(result.complete, note).toBe(!wrong && count <= 3);
      if (!wrong) {
        expect(result.windows, note).toEqual(truth.slice(-4));
      }
    }
  });
});
