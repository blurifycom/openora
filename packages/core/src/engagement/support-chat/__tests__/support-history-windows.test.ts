import { describe, expect, it } from 'vitest';
import { buildEmailWindows, toEmailChange } from '../service/support-history.service.js';

const REGISTERED_AT = new Date('2026-01-01T00:00:00.000Z');
const iso = (month: number) => `2026-${String(month).padStart(2, '0')}-01T00:00:00.000Z`;

const change = ({
  before,
  after,
  changedAt,
  writtenAt,
}: {
  before: string | null;
  after: string | null;
  changedAt: string | null;
  writtenAt: string;
}) =>
  toEmailChange({
    before: before === null ? null : { email: before },
    after: after === null ? null : { email: after, ...(changedAt === null ? {} : { changedAt }) },
    at: new Date(writtenAt),
    queued: false,
  });

const carried = (before: string | null, after: string, month: number) =>
  change({
    before,
    after,
    changedAt: iso(month),
    writtenAt: iso(month).replace(':00.000Z', ':01.000Z'),
  });

const build = (
  currentEmail: string,
  changes: ReturnType<typeof change>[],
  registeredEmail: string | null = 'a@x.test',
) => buildEmailWindows({ currentEmail, registeredEmail, registeredAt: REGISTERED_AT, changes });

const windowsHolding = (windows: { from: string; to: string | null }[], instant: string) =>
  windows.filter(
    (w) =>
      Date.parse(w.from) <= Date.parse(instant) &&
      (w.to === null || Date.parse(instant) < Date.parse(w.to)),
  );

describe('support history email windows', () => {
  it('an item inside the window of a previous email is attributed to that email', () => {
    const { windows, complete } = build('c@x.test', [
      carried('a@x.test', 'b@x.test', 2),
      carried('b@x.test', 'c@x.test', 4),
    ]);
    expect(complete).toBe(true);
    const holders = windowsHolding(windows, '2026-03-15T00:00:00.000Z');
    expect(holders.map((w) => ('email' in w ? w.email : null))).toEqual(['b@x.test']);
    expect(windowsHolding(windows, '2026-05-01T00:00:00.000Z')).toEqual([
      { email: 'c@x.test', from: iso(4), to: null },
    ]);
  });

  it('the first window is bounded by account creation when there is no earlier change', () => {
    const { windows, complete, broken } = build('b@x.test', [carried('a@x.test', 'b@x.test', 2)]);
    expect(windows[0]).toEqual({
      email: 'a@x.test',
      from: REGISTERED_AT.toISOString(),
      to: iso(2),
    });
    expect({ complete, broken }).toEqual({ complete: true, broken: false });
  });

  it('an item before the first window is excluded', () => {
    const { windows } = build('b@x.test', [carried('a@x.test', 'b@x.test', 2)]);
    expect(windowsHolding(windows, '2025-12-31T23:59:59.999Z')).toEqual([]);
    expect(windowsHolding(windows, REGISTERED_AT.toISOString())).toHaveLength(1);
  });

  it('only the three most recent previous emails are kept', () => {
    const { windows, complete, broken } = build('e@x.test', [
      carried('a@x.test', 'b@x.test', 2),
      carried('b@x.test', 'c@x.test', 3),
      carried('c@x.test', 'd@x.test', 4),
      carried('d@x.test', 'e@x.test', 5),
    ]);
    expect(windows.map((w) => w.email)).toEqual(['b@x.test', 'c@x.test', 'd@x.test', 'e@x.test']);
    expect({ complete, broken }).toEqual({ complete: false, broken: false });
  });

  it('a redelivered email change event is dropped and the first row stays', () => {
    const first = carried('a@x.test', 'b@x.test', 2);
    const repeat = change({
      before: 'a@x.test',
      after: 'b@x.test',
      changedAt: iso(2),
      writtenAt: '2026-02-01T00:00:09.000Z',
    });
    const { windows, complete, broken } = build('b@x.test', [first, repeat]);
    expect(windows).toEqual([
      { email: 'a@x.test', from: REGISTERED_AT.toISOString(), to: iso(2) },
      { email: 'b@x.test', from: iso(2), to: null },
    ]);
    expect({ complete, broken }).toEqual({ complete: true, broken: false });
  });

  it('a row timed by its write time is never dropped as a redelivery', () => {
    const row = () =>
      change({ before: 'a@x.test', after: 'b@x.test', changedAt: null, writtenAt: iso(2) });
    const { windows, broken } = build('b@x.test', [row(), row()]);
    expect(broken).toBe(true);
    expect(windows).toEqual([]);
  });

  it('an invalid carried change time falls back to the write time', () => {
    const row = change({
      before: 'a@x.test',
      after: 'b@x.test',
      changedAt: 'yesterday-ish',
      writtenAt: iso(2),
    });
    expect(row.timedByChange).toBe(false);
    expect(row.at.toISOString()).toBe(iso(2));
    const { windows } = build('b@x.test', [row]);
    expect(windows[1]).toEqual({ email: 'b@x.test', from: iso(2), to: null });
  });

  it('a change stamped within clock skew of its audit row keeps its carried time', () => {
    const within = change({
      before: 'a@x.test',
      after: 'b@x.test',
      changedAt: '2026-02-01T00:00:05.000Z',
      writtenAt: iso(2),
    });
    const ok = build('b@x.test', [within]);
    expect(ok.broken).toBe(false);
    expect(ok.windows[1]?.from).toBe('2026-02-01T00:00:05.000Z');

    const beyond = change({
      before: 'a@x.test',
      after: 'b@x.test',
      changedAt: '2026-02-01T00:00:05.001Z',
      writtenAt: iso(2),
    });
    const bad = build('b@x.test', [beyond]);
    expect(bad.broken).toBe(true);
    expect(bad.windows).toEqual([]);
  });

  it('a null before email yields an open ended window and a null after email yields none', () => {
    const lostBefore = build('b@x.test', [carried(null, 'b@x.test', 2)]);
    expect(lostBefore.windows).toEqual([{ email: 'b@x.test', from: iso(2), to: null }]);
    expect({ complete: lostBefore.complete, broken: lostBefore.broken }).toEqual({
      complete: false,
      broken: true,
    });

    const nullAfter = build('b@x.test', [
      change({ before: 'a@x.test', after: null, changedAt: iso(2), writtenAt: iso(2) }),
    ]);
    expect(nullAfter.windows).toEqual([]);
    expect(nullAfter.broken).toBe(true);
  });
});
