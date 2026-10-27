import { describe, it, expect } from 'vitest';
import type { SupportHistoryEmailWindow } from '@openora/core/contracts';
import { buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const FAR_FUTURE = new Date('2099-01-01T00:00:00.000Z');

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

// Same rule as the service: a row carrying its change time that repeats an earlier row is dropped.
const deduped = (rows: Row[]) => {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!r.timedByChange) {
      return true;
    }
    const key = JSON.stringify([r.before, r.after, r.at.getTime()]);
    return seen.has(key) ? false : (seen.add(key), true);
  });
};

/**
 * Mixes every corruption of the trail at once: wrong times (earlier, later, forward-dated,
 * before registration, equal to a neighbour), lost, swapped and duplicated rows, a redelivery that
 * lands anywhere, an empty `before` or `after`, and a mix of rows with a change time and legacy
 * rows. A window may be wider than the time the player truly held the email only when a row that
 * bounds it carries a wrong time that still sits strictly between the rows around it: nothing in
 * the trail can tell that one apart.
 */
describe('buildEmailWindows against every corruption at once', () => {
  it('answers a window wider than the truth only where the wrong time cannot be noticed', () => {
    const random = rng(20260103);
    const pick = (n: number) => Math.floor(random() * n);
    let widened = 0;
    let checked = 0;
    for (let trial = 0; trial < 20000; trial++) {
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
            // A redelivery landing anywhere.
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

      // A lost first change cannot be noticed: nothing records the email registered with.
      if (!rows.some((r) => r.before === email(0) || r.after === email(1))) {
        continue;
      }
      checked++;
      const final = deduped(rows);
      const result = buildEmailWindows({
        currentEmail: email(count),
        registeredAt: REGISTERED,
        // A legacy row is timed by its write; any other row was written at its true change time.
        changes: rows.map((r) => ({ ...r, writtenAt: r.timedByChange ? trueAt(r.id) : r.at })),
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

      // No window wider than the truth, unless a bounding row's wrong time is unnoticeable.
      const locallyOrdered = (row: Row) => {
        const at = final.indexOf(row);
        const before = final[at - 1]?.at ?? REGISTERED;
        const after = final[at + 1]?.at ?? new Date(8.64e15);
        return row.at > before && row.at < after;
      };
      for (const w of result.windows as SupportHistoryEmailWindow[]) {
        const j = Number(/^e(\d+)@/.exec(w.email)![1]);
        const wideFrom = Date.parse(w.from) < truthFrom(j).getTime();
        const wideTo = (w.to === null ? Infinity : Date.parse(w.to)) > truthTo(j);
        if (!wideFrom && !wideTo) {
          continue;
        }
        widened++;
        // A copy of a row may sit elsewhere in the list; the window rests on one that fits.
        const openers = final.filter((r) => r.after === w.email && r.at.toISOString() === w.from);
        const closers =
          w.to === null
            ? []
            : final.filter((r) => r.before === w.email && r.at.toISOString() === w.to);
        if (wideFrom) {
          expect(
            openers.length,
            `${note} no opener for a window widened at its start`,
          ).toBeGreaterThan(0);
          expect(openers.some(locallyOrdered), `${note} widened start, opener noticeable`).toBe(
            true,
          );
        }
        if (wideTo) {
          expect(
            closers.length,
            `${note} no closer for a window widened at its end`,
          ).toBeGreaterThan(0);
          expect(closers.some(locallyOrdered), `${note} widened end, closer noticeable`).toBe(true);
        }
      }

      if (JSON.stringify(rows) === original && rows.every((r) => r.before && r.after)) {
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
    // The attack must really have exercised the unnoticeable case and the plain one.
    expect(checked).toBeGreaterThan(10000);
    expect(widened).toBeGreaterThan(0);
  });
});
