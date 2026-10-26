import { describe, it, expect } from 'vitest';
import { buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));

// Seeded, so a failure replays.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};

type Row = { before: string | null; after: string | null; at: Date };

describe('buildEmailWindows against corrupted audit trails', () => {
  it('never reports a window wider than the time the player held that email', () => {
    const random = rng(20260101);
    const pick = (n: number) => Math.floor(random() * n);
    for (let trial = 0; trial < 5000; trial++) {
      const count = 1 + pick(6);
      const email = (i: number) => `e${i}@example.test`;
      const held = new Map<string, { from: Date; to: Date | null }>();
      const rows: Row[] = [];
      for (let i = 0; i < count; i++) {
        const at = day(10 * (i + 1));
        held.set(email(i), { from: i === 0 ? REGISTERED : day(10 * i), to: at });
        rows.push({ before: email(i), after: email(i + 1), at });
      }
      held.set(email(count), { from: day(10 * count), to: null });

      const structural = random() < 0.5;
      // A lost first change cannot be noticed (nothing records the registration email).
      for (let k = pick(4); k > 0; k--) {
        const i = pick(rows.length);
        // A row missing its new email beside a reordering is a compound fault: see the report.
        const kind = structural ? pick(3) : 3 + pick(2);
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

      if (!rows.some((row) => row.before === email(0) || row.after === email(1))) {
        continue;
      }
      const { windows } = buildEmailWindows({
        currentEmail: email(count),
        registeredAt: REGISTERED,
        changes: rows,
      });
      for (const w of windows) {
        const truth = held.get(w.email)!;
        const note = JSON.stringify({ trial, rows, w });
        expect(Date.parse(w.from), note).toBeGreaterThanOrEqual(truth.from.getTime());
        expect(w.to === null ? Infinity : Date.parse(w.to), note).toBeLessThanOrEqual(
          truth.to?.getTime() ?? Infinity,
        );
        expect(Date.parse(w.from), note).toBeLessThanOrEqual(
          w.to === null ? Infinity : Date.parse(w.to),
        );
      }
    }
  });
});
