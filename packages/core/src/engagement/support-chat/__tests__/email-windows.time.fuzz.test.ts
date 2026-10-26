import { describe, it, expect } from 'vitest';
import { buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

// Seeded, so a failure replays.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};

describe('buildEmailWindows against corrupted change times', () => {
  it('answers a window only for a trail whose times run strictly forward from registration', () => {
    const random = rng(20260102);
    const pick = (n: number) => Math.floor(random() * n);
    for (let trial = 0; trial < 5000; trial++) {
      const count = 1 + pick(6);
      const email = (i: number) => `e${i}@example.test`;
      // Mostly sound days, some wrong ones: back, equal, before registration.
      const days = Array.from({ length: count }, (_, i) =>
        random() < 0.4 ? pick(12) - 2 : 10 * (i + 1),
      );
      const changes = days.map((d, i) => ({ before: email(i), after: email(i + 1), at: day(d) }));
      const sound = days.every((d, i) => d > (i === 0 ? 0 : days[i - 1]!));

      const result = buildEmailWindows({
        currentEmail: email(count),
        registeredAt: REGISTERED,
        changes,
      });

      const note = JSON.stringify({ trial, days, result });
      expect(result.complete, note).toBe(sound);
      if (!sound) {
        expect(result.windows, note).toEqual([]);
        continue;
      }
      const { windows } = result;
      expect(windows.at(-1)?.to, note).toBeNull();
      windows.forEach((w, i) => {
        expect(Date.parse(w.from), note).toBeGreaterThanOrEqual(REGISTERED.getTime());
        if (w.to !== null) {
          expect(Date.parse(w.to), note).toBeGreaterThan(Date.parse(w.from));
          expect(windows[i + 1]?.from, note).toBe(w.to);
        }
      });
    }
  });
});
