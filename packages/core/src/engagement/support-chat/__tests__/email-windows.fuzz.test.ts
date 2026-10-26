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
  it('trusts no window for a corrupted trail, and none wider than the truth for an intact one', () => {
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

      if (!rows.some((row) => row.before === email(0) || row.after === email(1))) {
        continue;
      }
      const result = buildEmailWindows({
        currentEmail: email(count),
        registeredAt: REGISTERED,
        changes: rows,
      });
      const note = JSON.stringify({ trial, rows, result });
      if (JSON.stringify(rows) !== original) {
        expect(result, note).toEqual({ windows: [], complete: false });
        continue;
      }
      for (const w of result.windows) {
        const truth = held.get(w.email)!;
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
