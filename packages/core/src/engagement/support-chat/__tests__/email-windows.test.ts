import { describe, it, expect } from 'vitest';
import { SupportHistoryEmailWindowSchema } from '@openora/core/contracts';
import { buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const iso = (n: number) => day(n).toISOString();
const change = (before: string | null, after: string | null, n: number) => ({
  before: before && `${before}@example.test`,
  after: after && `${after}@example.test`,
  at: day(n),
});
const windowsOf = (currentEmail: string, changes: ReturnType<typeof change>[]) =>
  buildEmailWindows({
    currentEmail: currentEmail && `${currentEmail}@example.test`,
    registeredAt: REGISTERED,
    changes,
  });
const UNTRUSTED = { windows: [], complete: false };

describe('buildEmailWindows', () => {
  it('opens one window from registration for a player who never changed email', () => {
    const { windows, complete } = windowsOf('now', []);

    expect(windows).toEqual([
      { email: 'now@example.test', from: REGISTERED.toISOString(), to: null },
    ]);
    expect(complete).toBe(true);
    expect(windows.every((w) => SupportHistoryEmailWindowSchema.safeParse(w).success)).toBe(true);
  });

  it('closes each previous email at its change and opens the current one at the last', () => {
    expect(windowsOf('c', [change('a', 'b', 10), change('b', 'c', 20)])).toEqual({
      windows: [
        { email: 'a@example.test', from: REGISTERED.toISOString(), to: iso(10) },
        { email: 'b@example.test', from: iso(10), to: iso(20) },
        { email: 'c@example.test', from: iso(20), to: null },
      ],
      complete: true,
    });
  });

  it('keeps only the three most recent previous emails', () => {
    const changes = [1, 2, 3, 4, 5].map((n) => change(`e${n}`, n === 5 ? 'now' : `e${n + 1}`, n));

    expect(windowsOf('now', changes)).toEqual({
      windows: [
        { email: 'e3@example.test', from: iso(2), to: iso(3) },
        { email: 'e4@example.test', from: iso(3), to: iso(4) },
        { email: 'e5@example.test', from: iso(4), to: iso(5) },
        { email: 'now@example.test', from: iso(5), to: null },
      ],
      complete: true,
    });
  });

  it('cannot tell a lost first change, since nothing records the email registered with', () => {
    expect(windowsOf('c', [change('b', 'c', 20)])).toEqual({
      windows: [
        { email: 'b@example.test', from: REGISTERED.toISOString(), to: iso(20) },
        { email: 'c@example.test', from: iso(20), to: null },
      ],
      complete: true,
    });
  });

  it('counts a redelivered row, same emails and same carried change time, once', () => {
    const redelivered = { ...change('a', 'b', 10), timedByChange: true };

    expect(windowsOf('b', [redelivered, { ...redelivered }])).toEqual({
      windows: [
        { email: 'a@example.test', from: REGISTERED.toISOString(), to: iso(10) },
        { email: 'b@example.test', from: iso(10), to: null },
      ],
      complete: true,
    });
  });

  it.each([
    ['a repeated row timed by its write time', [change('a', 'b', 10), change('a', 'b', 10)]],
    [
      'a repeated row with another change time',
      [
        { ...change('a', 'b', 10), timedByChange: true },
        { ...change('a', 'b', 11), timedByChange: true },
      ],
    ],
    [
      'a repeat of a row timed by its write time',
      [change('a', 'b', 10), { ...change('a', 'b', 10), timedByChange: true }],
    ],
  ])('trusts no window for %s', (_fault, changes) => {
    expect(windowsOf('b', changes)).toEqual(UNTRUSTED);
  });

  it('counts three redeliveries once and keeps the windows of the changes around them', () => {
    const timed = (before: string, after: string, n: number) => ({
      ...change(before, after, n),
      timedByChange: true,
    });
    const first = timed('a', 'b', 10);

    expect(windowsOf('c', [first, { ...first }, { ...first }, timed('b', 'c', 20)])).toEqual({
      windows: [
        { email: 'a@example.test', from: REGISTERED.toISOString(), to: iso(10) },
        { email: 'b@example.test', from: iso(10), to: iso(20) },
        { email: 'c@example.test', from: iso(20), to: null },
      ],
      complete: true,
    });
  });

  it.each([
    [
      'a repeat that is not adjacent',
      'c',
      [
        { ...change('a', 'b', 10), timedByChange: true },
        { ...change('b', 'c', 20), timedByChange: true },
        { ...change('a', 'b', 10), timedByChange: true },
      ],
    ],
    [
      'a collapsed repeat that leaves the current email unexplained',
      'c',
      [
        { ...change('a', 'b', 10), timedByChange: true },
        { ...change('a', 'b', 10), timedByChange: true },
      ],
    ],
    [
      'a repeat whose emails differ only in case',
      'b',
      [
        { ...change('a', 'b', 10), timedByChange: true },
        { before: 'A@example.test', after: 'b@example.test', at: day(10), timedByChange: true },
      ],
    ],
    [
      'a repeat whose new email differs only in case',
      'b',
      [
        { ...change('a', 'b', 10), timedByChange: true },
        { before: 'a@example.test', after: 'B@example.test', at: day(10), timedByChange: true },
      ],
    ],
  ])('trusts no window for %s', (_fault, current, changes) => {
    expect(windowsOf(current, changes)).toEqual(UNTRUSTED);
  });

  it('answers no window and no gap for an account with no email and no change', () => {
    expect(windowsOf('', [])).toEqual({ windows: [], complete: true });
  });

  it.each([
    ['a change without the replaced email', 'c', [change('a', 'b', 10), change(null, 'c', 20)]],
    ['a change without the new email', 'c', [change('a', null, 10)]],
    ['a lost middle change', 'd', [change('a', 'b', 10), change('c', 'd', 30)]],
    ['a lost last change', 'c', [change('a', 'b', 10)]],
    ['a duplicated row', 'b', [change('a', 'b', 10), change('a', 'b', 11)]],
    ['rows written out of order', 'c', [change('b', 'c', 20), change('a', 'b', 21)]],
    [
      'a time that falls back',
      'd',
      [change('a', 'b', 10), change('b', 'c', 5), change('c', 'd', 7)],
    ],
    [
      'a time that jumps ahead',
      'c',
      [change('x', 'a', 10), change('a', 'b', 30), change('b', 'c', 20)],
    ],
    ['two changes at the same time', 'c', [change('a', 'b', 10), change('b', 'c', 10)]],
    ['a change at registration', 'b', [change('a', 'b', 0)]],
    [
      'a missing new email beside a reordering',
      'c',
      [change('b', 'c', 20), change('a', null, 21), change('b', 'c', 22)],
    ],
    ['changes on an account with no email', '', [change('a', 'b', 10)]],
  ])('trusts no window for %s', (_fault, current, changes) => {
    expect(windowsOf(current, changes)).toEqual(UNTRUSTED);
  });
});
