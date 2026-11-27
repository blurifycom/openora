import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  boundFirstWindow,
  buildEmailWindows,
  withoutRedeliveries,
} from '../support-history.service.js';

type Change = Parameters<typeof buildEmailWindows>[0]['changes'][number];

const T = (day: number, extraMs = 0) => new Date(Date.UTC(2026, 0, day) + extraMs);
const REGISTERED = T(1);

const change = (over: Partial<Change>): Change => ({
  before: 'a@example.test',
  after: 'b@example.test',
  at: T(5),
  writtenAt: T(5, 1000),
  timedByChange: true,
  ...over,
});

const build = (over: Partial<Parameters<typeof buildEmailWindows>[0]>) =>
  buildEmailWindows({
    currentEmail: 'b@example.test',
    registeredEmail: 'a@example.test',
    registeredAt: REGISTERED,
    changes: [],
    ...over,
  });

describe('withoutRedeliveries', () => {
  it('drops a repeat of the same emails and carried time', () => {
    const first = change({});
    expect(withoutRedeliveries([first, { ...first }])).toEqual([first]);
  });

  it('keeps the first of the repeats in place', () => {
    const first = change({ writtenAt: T(5, 1) });
    const repeat = change({ writtenAt: T(5, 9000) });
    const other = change({
      before: 'b@example.test',
      after: 'c@example.test',
      at: T(6),
      writtenAt: T(6, 1),
    });
    expect(withoutRedeliveries([first, other, repeat])).toEqual([first, other]);
  });

  it('never drops rows timed by their write time, even when identical', () => {
    const row = change({ timedByChange: false });
    expect(withoutRedeliveries([row, { ...row }, { ...row }])).toHaveLength(3);
  });

  it.each([
    ['before', { before: 'z@example.test' }],
    ['after', { after: 'z@example.test' }],
    ['carried time', { at: T(5, 1) }],
  ])('keeps a row that differs in %s', (_field, over) => {
    expect(withoutRedeliveries([change({}), change(over)])).toHaveLength(2);
  });

  it('does not confuse null emails with the string null', () => {
    const rows = [change({ before: null, after: 'x' }), change({ before: 'null', after: 'x' })];
    expect(withoutRedeliveries(rows)).toHaveLength(2);
  });

  it('does not confuse emails that join into the same text', () => {
    const rows = [change({ before: 'a,b', after: 'c' }), change({ before: 'a', after: 'b,c' })];
    expect(withoutRedeliveries(rows)).toHaveLength(2);
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            before: fc.option(fc.constantFrom('a', 'b'), { nil: null }),
            after: fc.option(fc.constantFrom('a', 'b'), { nil: null }),
            at: fc.integer({ min: 0, max: 3 }).map((n) => T(1 + n)),
            writtenAt: fc.constant(T(30)),
            timedByChange: fc.boolean(),
          }),
          { maxLength: 12 },
        ),
        (rows) => {
          const once = withoutRedeliveries(rows);
          expect(withoutRedeliveries(once)).toEqual(once);
        },
      ),
    );
  });
});

describe('buildEmailWindows', () => {
  it('gives one open window from registration when nothing changed', () => {
    expect(build({ currentEmail: 'a@example.test' })).toEqual({
      windows: [{ email: 'a@example.test', from: REGISTERED.toISOString(), to: null }],
      complete: true,
      broken: false,
    });
  });

  it('builds two windows for one change, oldest first, current open-ended', () => {
    expect(build({ changes: [change({})] })).toEqual({
      windows: [
        { email: 'a@example.test', from: REGISTERED.toISOString(), to: T(5).toISOString() },
        { email: 'b@example.test', from: T(5).toISOString(), to: null },
      ],
      complete: true,
      broken: false,
    });
  });

  it('chains three emails through two changes', () => {
    const result = build({
      currentEmail: 'c@example.test',
      changes: [
        change({}),
        change({
          before: 'b@example.test',
          after: 'c@example.test',
          at: T(8),
          writtenAt: T(8, 10),
        }),
      ],
    });
    expect(result.windows.map((w) => w.email)).toEqual([
      'a@example.test',
      'b@example.test',
      'c@example.test',
    ]);
    expect(result.windows[1]).toEqual({
      email: 'b@example.test',
      from: T(5).toISOString(),
      to: T(8).toISOString(),
    });
    expect(result.complete).toBe(true);
  });

  it('has no windows and is complete for an account with no email and no changes', () => {
    expect(build({ currentEmail: '', changes: [] })).toEqual({
      windows: [],
      complete: true,
      broken: false,
    });
  });

  it('is broken with no windows for an account with no email but a trail', () => {
    expect(build({ currentEmail: '', changes: [change({})] })).toEqual({
      windows: [],
      complete: false,
      broken: true,
    });
  });

  it('breaks when the last change did not produce the current email', () => {
    const result = build({ currentEmail: 'x@example.test', changes: [change({})] });
    expect(result).toEqual({ windows: [], complete: false, broken: true });
  });

  it('breaks when a change time is not after registration', () => {
    const result = build({ changes: [change({ at: REGISTERED, writtenAt: T(1, 1000) })] });
    expect(result.broken).toBe(true);
    expect(result.windows).toEqual([]);
  });

  it('accepts a change one millisecond after registration', () => {
    const result = build({ changes: [change({ at: T(1, 1), writtenAt: T(1, 2) })] });
    expect(result.broken).toBe(false);
  });

  it('allows a change time up to 5 seconds ahead of its audit write and refuses 1ms more', () => {
    const ahead = (ms: number) => build({ changes: [change({ at: T(5, ms), writtenAt: T(5) })] });
    expect(ahead(5000).broken).toBe(false);
    expect(ahead(5001).broken).toBe(true);
  });

  it('breaks every later change after one claiming a time in the future', () => {
    const result = build({
      currentEmail: 'c@example.test',
      changes: [
        change({ at: T(20), writtenAt: T(5) }),
        change({
          before: 'b@example.test',
          after: 'c@example.test',
          at: T(8),
          writtenAt: T(8, 10),
        }),
      ],
    });
    expect(result.broken).toBe(true);
    expect(result.complete).toBe(false);
  });

  it('refuses a change that is not later than an earlier change', () => {
    const result = build({
      currentEmail: 'c@example.test',
      changes: [
        change({ at: T(8), writtenAt: T(8, 10) }),
        change({
          before: 'b@example.test',
          after: 'c@example.test',
          at: T(8),
          writtenAt: T(8, 10),
        }),
      ],
    });
    expect(result.broken).toBe(true);
  });

  it('drops the windows older than a break and keeps the ones after it', () => {
    const result = build({
      currentEmail: 'd@example.test',
      registeredEmail: 'a@example.test',
      changes: [
        change({ before: 'a@example.test', after: 'x@example.test', at: T(3), writtenAt: T(3, 5) }),
        change({ before: 'b@example.test', after: 'c@example.test', at: T(5), writtenAt: T(5, 5) }),
        change({ before: 'c@example.test', after: 'd@example.test', at: T(7), writtenAt: T(7, 5) }),
      ],
    });
    expect(result.broken).toBe(true);
    expect(result.windows.map((w) => w.email)).toEqual(['c@example.test', 'd@example.test']);
  });

  it('breaks when the first change has no before email', () => {
    const result = build({ changes: [change({ before: null })] });
    expect(result.broken).toBe(true);
    expect(result.windows.map((w) => w.email)).toEqual(['b@example.test']);
  });

  it('compares the registered email case-insensitively', () => {
    expect(build({ registeredEmail: 'A@Example.Test', changes: [change({})] }).broken).toBe(false);
  });

  it('breaks when the oldest email is not the registered one', () => {
    const result = build({ registeredEmail: 'other@example.test', changes: [change({})] });
    expect(result.broken).toBe(true);
    expect(result.windows).toEqual([
      { email: 'b@example.test', from: T(5).toISOString(), to: null },
    ]);
  });

  it('accepts a null registered email', () => {
    expect(build({ registeredEmail: null, changes: [change({})] }).broken).toBe(false);
  });

  it('counts a redelivered change once', () => {
    const row = change({});
    expect(build({ changes: [row, { ...row }] })).toEqual(build({ changes: [row] }));
  });

  it('keeps the current email and 3 previous ones and reports the cap as incomplete but not broken', () => {
    const emails = ['a', 'b', 'c', 'd', 'e', 'f'].map((n) => `${n}@example.test`);
    const changes = emails
      .slice(1)
      .map((after, i) =>
        change({ before: emails[i] ?? null, after, at: T(2 + i), writtenAt: T(2 + i, 5) }),
      );
    const result = build({
      currentEmail: 'f@example.test',
      registeredEmail: 'a@example.test',
      changes,
    });
    expect(result.windows.map((w) => w.email)).toEqual(emails.slice(2));
    expect(result.windows).toHaveLength(4);
    expect(result.complete).toBe(false);
    expect(result.broken).toBe(false);
  });

  it('is complete at exactly the cap', () => {
    const emails = ['a', 'b', 'c', 'd'].map((n) => `${n}@example.test`);
    const changes = emails
      .slice(1)
      .map((after, i) =>
        change({ before: emails[i] ?? null, after, at: T(2 + i), writtenAt: T(2 + i, 5) }),
      );
    const result = build({
      currentEmail: 'd@example.test',
      registeredEmail: 'a@example.test',
      changes,
    });
    expect(result.windows).toHaveLength(4);
    expect(result.complete).toBe(true);
  });

  it('always returns windows that are contiguous and end open', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 3 }), (n) => {
        const emails = Array.from({ length: n + 1 }, (_, i) => `u${i}@example.test`);
        const changes = emails
          .slice(1)
          .map((after, i) =>
            change({ before: emails[i] ?? null, after, at: T(2 + i), writtenAt: T(2 + i, 5) }),
          );
        const { windows, broken } = build({
          currentEmail: emails[n] ?? '',
          registeredEmail: emails[0] ?? null,
          changes,
        });
        expect(broken).toBe(false);
        expect(windows.at(-1)?.to).toBeNull();
        windows.slice(1).forEach((w, i) => {
          expect(windows[i]?.to).toBe(w.from);
        });
      }),
    );
  });
});

describe('boundFirstWindow', () => {
  const built = () => build({ changes: [change({})] });
  const other = (over: Partial<Parameters<typeof boundFirstWindow>[2][number]>) => ({
    before: null,
    after: null,
    at: T(3),
    ...over,
  });

  it('returns the windows untouched without other accounts', () => {
    expect(boundFirstWindow(built(), REGISTERED, [])).toEqual(built());
  });

  it('returns an incomplete result as it is', () => {
    const incomplete = build({ currentEmail: 'x@example.test', changes: [change({})] });
    expect(boundFirstWindow(incomplete, REGISTERED, [other({ after: 'a@example.test' })])).toBe(
      incomplete,
    );
  });

  it('opens the window later when another account left the address', () => {
    const result = boundFirstWindow(built(), REGISTERED, [other({ before: 'a@example.test' })]);
    expect(result.windows[0]).toEqual({
      email: 'a@example.test',
      from: T(3).toISOString(),
      to: T(5).toISOString(),
    });
    expect(result.complete).toBe(false);
    expect(result.broken).toBe(true);
  });

  it('drops the window when another account took the address', () => {
    const result = boundFirstWindow(built(), REGISTERED, [other({ after: 'A@EXAMPLE.TEST' })]);
    expect(result.windows.map((w) => w.email)).toEqual(['b@example.test']);
    expect(result.broken).toBe(true);
  });

  it('lets the latest of several other changes decide', () => {
    const result = boundFirstWindow(built(), REGISTERED, [
      other({ after: 'a@example.test', at: T(2) }),
      other({ before: 'a@example.test', at: T(4) }),
    ]);
    expect(result.windows[0]?.from).toBe(T(4).toISOString());
  });

  it('fails closed on a tie, the account taking the address wins', () => {
    const rows = [
      other({ before: 'a@example.test', at: T(3) }),
      other({ after: 'a@example.test', at: T(3) }),
    ];
    expect(boundFirstWindow(built(), REGISTERED, rows).windows.map((w) => w.email)).toEqual([
      'b@example.test',
    ]);
    expect(
      boundFirstWindow(built(), REGISTERED, [...rows].reverse()).windows.map((w) => w.email),
    ).toEqual(['b@example.test']);
  });

  it('ignores a change at registration time and one at the window close', () => {
    const rows = [
      other({ after: 'a@example.test', at: REGISTERED }),
      other({ after: 'a@example.test', at: T(5) }),
    ];
    expect(boundFirstWindow(built(), REGISTERED, rows)).toEqual(built());
  });

  it('ignores changes before registration and after the window closed', () => {
    const rows = [
      other({ after: 'a@example.test', at: T(1, -1) }),
      other({ after: 'a@example.test', at: T(6) }),
    ];
    expect(boundFirstWindow(built(), REGISTERED, rows)).toEqual(built());
  });

  it('bounds an open-ended first window with no close', () => {
    const open = build({ currentEmail: 'a@example.test' });
    const result = boundFirstWindow(open, REGISTERED, [
      other({ after: 'a@example.test', at: T(900) }),
    ]);
    expect(result.windows).toEqual([]);
    expect(result.broken).toBe(true);
  });

  it('ignores changes naming other addresses', () => {
    expect(
      boundFirstWindow(built(), REGISTERED, [
        other({ before: 'q@example.test', after: 'r@example.test' }),
      ]),
    ).toEqual(built());
  });
});
