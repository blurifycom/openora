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

type Row = { before: string | null; after: string | null; at: Date; timedByChange: boolean };

describe('buildEmailWindows against corrupted audit trails', () => {
  it('answers no window wider than the truth, and the whole truth only when complete', () => {
    const random = rng(20260101);
    const pick = (n: number) => Math.floor(random() * n);
    for (let trial = 0; trial < 5000; trial++) {
      const count = 1 + pick(6);
      const email = (i: number) => `e${i}@example.test`;
      const truth: SupportHistoryEmailWindow[] = [];
      const rows: Row[] = [];
      for (let i = 0; i < count; i++) {
        const at = day(10 * (i + 1));
        truth.push({
          email: email(i),
          from: (i === 0 ? REGISTERED : day(10 * i)).toISOString(),
          to: at.toISOString(),
        });
        rows.push({ before: email(i), after: email(i + 1), at, timedByChange: false });
      }
      truth.push({ email: email(count), from: day(10 * count).toISOString(), to: null });
      const held = new Map(truth.map((w) => [w.email, w]));

      const original = JSON.stringify(rows);
      for (let k = pick(4); k > 0; k--) {
        const i = pick(rows.length);
        const kind = pick(5);
        switch (kind) {
          case 0:
            rows.splice(i, 1);
            break;
          case 1:
            if (i + 1 < rows.length) {
              [rows[i], rows[i + 1]] = [rows[i + 1]!, rows[i]!];
            }
            break;
          case 2:
            rows.splice(i, 0, { ...rows[i]! });
            break;
          case 3:
            rows[i] = { ...rows[i]!, before: null };
            break;
          default:
            rows[i] = { ...rows[i]!, after: null };
        }
      }

      // A lost first change cannot be noticed: nothing records the email registered with.
      if (!rows.some((row) => row.before === email(0) || row.after === email(1))) {
        continue;
      }
      const result = buildEmailWindows({
        currentEmail: email(count),
        registeredAt: REGISTERED,
        changes: rows,
      });
      const note = JSON.stringify({ trial, rows, result });
      for (const w of result.windows) {
        const span = held.get(w.email)!;
        expect(Date.parse(w.from), note).toBeGreaterThanOrEqual(Date.parse(span.from));
        expect(w.to === null ? Infinity : Date.parse(w.to), note).toBeLessThanOrEqual(
          span.to === null ? Infinity : Date.parse(span.to),
        );
        expect(Date.parse(w.from), note).toBeLessThan(w.to === null ? Infinity : Date.parse(w.to));
      }
      if (JSON.stringify(rows) !== original) {
        expect(result.complete, note).toBe(false);
        continue;
      }
      expect(result, note).toEqual({
        windows: truth.slice(-4),
        complete: count <= 3,
        broken: false,
      });
    }
  });
});
