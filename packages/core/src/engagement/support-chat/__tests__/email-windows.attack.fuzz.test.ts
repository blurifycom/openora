import { describe, it, expect } from 'vitest';
import { buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');
const CLOCK_SKEW_MS = 5_000;
const END_OF_TIME = 8.64e15;

// Seeded, so a failure replays.
const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 2 ** 32;
  return seed / 2 ** 32;
};

type Row = {
  id: number;
  before: string | null;
  after: string | null;
  at: Date;
  timedByChange: boolean;
};
type Change = Row & { writtenAt: Date };

// The oracle's own copy of the redelivery rule, so a bug in the service's cannot hide here.
const collapseRedeliveries = (changes: Change[]) => {
  const seen = new Set<string>();
  return changes.filter((c) => {
    if (!c.timedByChange) {
      return true;
    }
    const key = JSON.stringify([c.before, c.after, c.at.getTime()]);
    return seen.has(key) ? false : (seen.add(key), true);
  });
};

const latestTrueTime = (c: Change) =>
  Math.min(c.at.getTime(), c.writtenAt.getTime() + CLOCK_SKEW_MS);

describe('buildEmailWindows against every corruption at once', () => {
  it('answers a window wider than the truth only where the wrong time cannot be noticed', () => {
    const random = rng(20260103);
    const pick = (n: number) => Math.floor(random() * n);
    let widened = 0;
    let checked = 0;
    for (let trial = 0; trial < 5000; trial++) {
      const count = 1 + pick(6);
      const email = (i: number) => `e${i}@example.test`;
      const trueAt = (i: number) => day(10 * (i + 1));
      const truthFrom = (i: number) => (i === 0 ? REGISTERED : trueAt(i - 1));
      const truthTo = (i: number) => (i === count ? Infinity : trueAt(i).getTime());
      const rows: Row[] = Array.from({ length: count }, (_, i) => ({
        id: i,
        before: email(i),
        after: email(i + 1),
        at: trueAt(i),
        timedByChange: pick(2) === 0,
      }));
      const original = JSON.stringify(rows);

      for (let k = pick(5); k > 0; k--) {
        const i = pick(rows.length);
        const row = rows[i];
        if (!row) {
          break;
        }
        switch (pick(9)) {
          case 0:
            rows.splice(i, 1);
            break;
          case 1:
            if (i + 1 < rows.length) {
              [rows[i], rows[i + 1]] = [rows[i + 1]!, row];
            }
            break;
          case 2:
            rows.splice(pick(rows.length + 1), 0, { ...row });
            break;
          case 3:
            rows[i] = { ...row, before: null };
            break;
          case 4:
            rows[i] = { ...row, after: null };
            break;
          case 5:
            rows[i] = { ...row, at: day(10 * (row.id + 1) + (pick(61) - 30)) };
            break;
          case 6:
            rows[i] = { ...row, at: pick(2) === 0 ? FAR_FUTURE : day(-1 - pick(3)) };
            break;
          case 7:
            rows[i] = { ...row, at: (rows[i + pick(3) - 1] ?? row).at };
            break;
          default:
            rows[i] = { ...row, timedByChange: !row.timedByChange };
        }
      }

      const lostFirstChange = !rows.some((r) => r.before === email(0) || r.after === email(1));
      if (lostFirstChange) {
        continue;
      }
      checked++;
      const changes: Change[] = rows.map((r) => ({
        ...r,
        writtenAt: r.timedByChange ? trueAt(r.id) : r.at,
      }));
      const final = collapseRedeliveries(changes);
      const result = buildEmailWindows({
        currentEmail: email(count),
        registeredAt: REGISTERED,
        changes,
      });
      const note = JSON.stringify({ trial, rows, result });

      expect(result.windows.length, note).toBeLessThanOrEqual(4);
      expect(result.broken && result.complete, note).toBe(false);
      for (const [n, w] of result.windows.entries()) {
        expect(Date.parse(w.from), note).toBeLessThan(w.to === null ? Infinity : Date.parse(w.to));
        const next = result.windows[n + 1];
        expect(w.to, note).toBe(next ? next.from : null);
      }
      if (result.complete) {
        expect(result.windows[0]?.from, note).toBe(REGISTERED.toISOString());
      }

      const unnoticeable = (c: Change) => {
        const at = final.indexOf(c);
        const previous = final[at - 1];
        const after = final[at + 1]?.at.getTime() ?? END_OF_TIME;
        const before = previous ? latestTrueTime(previous) : REGISTERED.getTime();
        return c.at.getTime() > before && c.at.getTime() < after;
      };
      for (const w of result.windows) {
        const j = Number(/^e(\d+)@/.exec(w.email)?.[1]);
        const wideFrom = Date.parse(w.from) < truthFrom(j).getTime();
        const wideTo = (w.to === null ? Infinity : Date.parse(w.to)) > truthTo(j);
        if (!wideFrom && !wideTo) {
          continue;
        }
        widened++;
        const openers = final.filter((c) => c.after === w.email && c.at.toISOString() === w.from);
        const closers =
          w.to === null
            ? []
            : final.filter((c) => c.before === w.email && c.at.toISOString() === w.to);
        if (wideFrom) {
          expect(openers.some(unnoticeable), `${note} widened start, opener noticeable`).toBe(true);
        }
        if (wideTo) {
          expect(closers.some(unnoticeable), `${note} widened end, closer noticeable`).toBe(true);
        }
      }

      if (JSON.stringify(rows) === original) {
        expect(result.windows, note).toEqual(
          Array.from({ length: count + 1 }, (_, i) => ({
            email: email(i),
            from: truthFrom(i).toISOString(),
            to: i === count ? null : trueAt(i).toISOString(),
          })).slice(-4),
        );
        expect(result.complete, note).toBe(count <= 3);
      }
    }
    expect(checked).toBeGreaterThan(2500);
    expect(widened).toBeGreaterThan(0);
  });
});
