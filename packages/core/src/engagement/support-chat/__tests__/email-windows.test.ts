import { describe, it, expect } from 'vitest';
import { SupportHistoryEmailWindowSchema } from '@openora/core/contracts';
import { boundFirstWindow, buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const iso = (n: number) => day(n).toISOString();
const CLOCK_SKEW_MS = 5_000;
// A change stamped on day `n` whose audit row was written on day `written`.
const change = (
  before: string | null,
  after: string | null,
  n: number,
  timedByChange = false,
  written = n,
) => ({
  before: before && `${before}@example.test`,
  after: after && `${after}@example.test`,
  at: day(n),
  writtenAt: day(written),
  timedByChange,
});
// A window for `email` from day `from` (null: registration) to day `to` (null: still held).
const held = (email: string, from: number | null, to: number | null) => ({
  email: `${email}@example.test`,
  from: from === null ? REGISTERED.toISOString() : iso(from),
  to: to === null ? null : iso(to),
});
const windowsOf = (currentEmail: string, changes: ReturnType<typeof change>[]) =>
  buildEmailWindows({
    currentEmail: currentEmail && `${currentEmail}@example.test`,
    registeredAt: REGISTERED,
    changes,
  });
const whole = (...windows: ReturnType<typeof held>[]) => ({
  windows,
  complete: true,
  broken: false,
});
const afterBreak = (...windows: ReturnType<typeof held>[]) => ({
  windows,
  complete: false,
  broken: true,
});
const UNTRUSTED = afterBreak();

describe('buildEmailWindows', () => {
  it('opens one window from registration for a player who never changed email', () => {
    const result = windowsOf('now', []);

    expect(result).toEqual(whole(held('now', null, null)));
    expect(result.windows.every((w) => SupportHistoryEmailWindowSchema.safeParse(w).success)).toBe(
      true,
    );
  });

  it('closes each previous email at its change and opens the current one at the last', () => {
    expect(windowsOf('c', [change('a', 'b', 10), change('b', 'c', 20)])).toEqual(
      whole(held('a', null, 10), held('b', 10, 20), held('c', 20, null)),
    );
  });

  it('searches every email of an intact trail of three changes', () => {
    const changes = [change('a', 'b', 1), change('b', 'c', 2), change('c', 'now', 3)];

    expect(windowsOf('now', changes)).toEqual(
      whole(held('a', null, 1), held('b', 1, 2), held('c', 2, 3), held('now', 3, null)),
    );
  });

  it('keeps the three most recent previous emails of an intact trail and says it is not complete', () => {
    const changes = [1, 2, 3, 4, 5].map((n) => change(`e${n}`, n === 5 ? 'now' : `e${n + 1}`, n));

    expect(windowsOf('now', changes)).toEqual({
      windows: [held('e3', 2, 3), held('e4', 3, 4), held('e5', 4, 5), held('now', 5, null)],
      complete: false,
      broken: false,
    });
  });

  it('cannot tell a lost first change, since nothing records the email registered with', () => {
    expect(windowsOf('c', [change('b', 'c', 20)])).toEqual(
      whole(held('b', null, 20), held('c', 20, null)),
    );
  });

  it('cannot tell a clock running behind whose stamps still follow every earlier one', () => {
    const lagDays = 5;
    const changes = [
      change('a', 'b', 10),
      change('b', 'c', 20 - lagDays),
      change('c', 'd', 30 - lagDays),
    ];

    expect(windowsOf('d', changes)).toEqual(
      whole(held('a', null, 10), held('b', 10, 15), held('c', 15, 25), held('d', 25, null)),
    );
  });

  it('keeps the windows after a break in the middle of the trail', () => {
    const changes = [
      change('a', 'b', 10),
      change('x', 'c', 20),
      change('c', 'd', 30),
      change('d', 'e', 40),
    ];

    expect(windowsOf('e', changes)).toEqual(
      afterBreak(held('c', 20, 30), held('d', 30, 40), held('e', 40, null)),
    );
  });

  it('keeps only the current window after a break right before the last change', () => {
    const changes = [change('a', 'b', 10), change('b', 'c', 20), change('x', 'd', 30)];

    expect(windowsOf('d', changes)).toEqual(afterBreak(held('d', 30, null)));
  });

  it('caps the windows kept after a break', () => {
    const changes = [
      change('a', 'x', 1),
      ...[2, 3, 4, 5, 6].map((n) => change(`e${n}`, `e${n + 1}`, n)),
    ];

    expect(windowsOf('e7', changes)).toEqual(
      afterBreak(held('e4', 3, 4), held('e5', 4, 5), held('e6', 5, 6), held('e7', 6, null)),
    );
  });

  it('trusts a change time ahead of its audit write by no more than the clock skew', () => {
    const skewed = {
      ...change('a', 'b', 10, true),
      writtenAt: new Date(day(10).getTime() - CLOCK_SKEW_MS),
    };

    expect(windowsOf('b', [skewed])).toEqual(whole(held('a', null, 10), held('b', 10, null)));
  });

  it('trusts no window for a change time more than the clock skew ahead of its audit write', () => {
    const ahead = {
      ...change('a', 'b', 10, true),
      writtenAt: new Date(day(10).getTime() - CLOCK_SKEW_MS - 1),
    };

    expect(windowsOf('b', [ahead])).toEqual(UNTRUSTED);
  });

  it('counts a redelivered row, same emails and same carried change time, once', () => {
    const redelivered = change('a', 'b', 10, true);

    expect(windowsOf('b', [redelivered, { ...redelivered }])).toEqual(
      whole(held('a', null, 10), held('b', 10, null)),
    );
  });

  it('counts three redeliveries once and keeps the windows of the changes around them', () => {
    const first = change('a', 'b', 10, true);

    expect(windowsOf('c', [first, { ...first }, { ...first }, change('b', 'c', 20, true)])).toEqual(
      whole(held('a', null, 10), held('b', 10, 20), held('c', 20, null)),
    );
  });

  it('counts a redelivery landing after a later change once, keeping the first in place', () => {
    expect(
      windowsOf('c', [
        change('a', 'b', 10, true),
        change('b', 'c', 20, true),
        change('a', 'b', 10, true),
      ]),
    ).toEqual(whole(held('a', null, 10), held('b', 10, 20), held('c', 20, null)));
  });

  it('answers no window and no gap for an account with no email and no change', () => {
    expect(windowsOf('', [])).toEqual(whole());
  });

  it.each([
    ['a lost last change', 'c', [change('a', 'b', 10)]],
    ['a change without the new email', 'c', [change('a', null, 10)]],
    ['rows written out of order', 'c', [change('b', 'c', 20), change('a', 'b', 21)]],
    ['changes on an account with no email', '', [change('a', 'b', 10)]],
    ['a repeated row timed by its write time', 'b', [change('a', 'b', 10), change('a', 'b', 10)]],
    [
      'a repeat of a row timed by its write time',
      'b',
      [change('a', 'b', 10), change('a', 'b', 10, true)],
    ],
    [
      'a time that jumps ahead',
      'c',
      [change('x', 'a', 10), change('a', 'b', 30), change('b', 'c', 20)],
    ],
    ['two changes at the same time', 'c', [change('a', 'b', 10), change('b', 'c', 10)]],
    ['a change at registration', 'b', [change('a', 'b', 0)]],
    [
      'a time later than the change before it but not than an earlier one',
      'd',
      [change('a', 'b', 10), change('b', 'c', 5), change('c', 'd', 7)],
    ],
    [
      'later changes after one claiming a time far beyond its audit write',
      'd',
      [change('a', 'b', 10), change('b', 'c', 900, true, 20), change('c', 'd', 30)],
    ],
    [
      'a run stamped before an earlier change that is not its neighbour',
      'e',
      [change('a', 'b', 10), change('b', 'c', 20), change('c', 'd', 5), change('d', 'e', 6)],
    ],
    [
      'a run of changes stamped before registration',
      'c',
      [change('a', 'b', -800), change('b', 'c', -700)],
    ],
    [
      'a later repeat with another change time',
      'c',
      [change('a', 'b', 10, true), change('b', 'c', 20, true), change('a', 'b', 11, true)],
    ],
    [
      'a later repeat timed by its write time',
      'c',
      [change('a', 'b', 10, true), change('b', 'c', 20, true), change('a', 'b', 10)],
    ],
    [
      'a repeat whose emails differ only in case',
      'b',
      [
        change('a', 'b', 10, true),
        {
          before: 'A@example.test',
          after: 'b@example.test',
          at: day(10),
          writtenAt: day(10),
          timedByChange: true,
        },
      ],
    ],
    [
      'a repeat whose new email differs only in case',
      'b',
      [
        change('a', 'b', 10, true),
        {
          before: 'a@example.test',
          after: 'B@example.test',
          at: day(10),
          writtenAt: day(10),
          timedByChange: true,
        },
      ],
    ],
  ])('trusts no window, not even the current one, for %s', (_fault, current, changes) => {
    expect(windowsOf(current, changes)).toEqual(UNTRUSTED);
  });

  it.each([
    [
      'a change without the replaced email',
      'c',
      [change('a', 'b', 10), change(null, 'c', 20)],
      [held('c', 20, null)],
    ],
    [
      'a lost middle change',
      'd',
      [change('a', 'b', 10), change('c', 'd', 30)],
      [held('d', 30, null)],
    ],
    ['a duplicated row', 'b', [change('a', 'b', 10), change('a', 'b', 11)], [held('b', 11, null)]],
    [
      'a repeated row with another change time',
      'b',
      [change('a', 'b', 10, true), change('a', 'b', 11, true)],
      [held('b', 11, null)],
    ],
    [
      'a missing new email beside a reordering',
      'c',
      [change('b', 'c', 20), change('a', null, 21), change('b', 'c', 22)],
      [held('c', 22, null)],
    ],
  ])('keeps only the windows after %s', (_fault, current, changes, windows) => {
    expect(windowsOf(current, changes)).toEqual(afterBreak(...windows));
  });
});

describe('boundFirstWindow', () => {
  // Another account's change on day `n`.
  const other = (before: string | null, after: string | null, n: number) => ({
    before: before && `${before}@example.test`,
    after: after && `${after}@example.test`,
    at: day(n),
  });
  const bound = (
    currentEmail: string,
    changes: ReturnType<typeof change>[],
    others: ReturnType<typeof other>[],
  ) => boundFirstWindow(windowsOf(currentEmail, changes), REGISTERED, others);

  it('keeps the result when no other account named the address', () => {
    const changes = [change('a', 'b', 10)];

    expect(bound('b', changes, [other('x', 'y', 5), other('b', 'z', 20)])).toEqual(
      whole(held('a', null, 10), held('b', 10, null)),
    );
  });

  it('opens the window when another account left the address inside it', () => {
    expect(bound('b', [], [other('b', 'q', 5)])).toEqual(afterBreak(held('b', 5, null)));
    expect(bound('b', [change('a', 'b', 10)], [other('a', 'q', 4)])).toEqual(
      afterBreak(held('a', 4, 10), held('b', 10, null)),
    );
  });

  it('drops the window when another account took the address inside it', () => {
    expect(bound('b', [], [other('q', 'b', 5)])).toEqual(UNTRUSTED);
    expect(bound('b', [change('a', 'b', 10)], [other('q', 'a', 4)])).toEqual(
      afterBreak(held('b', 10, null)),
    );
  });

  it('decides by the latest change, a tie going to the one taking the address', () => {
    expect(bound('b', [], [other('b', 'q', 7), other('q', 'b', 3)])).toEqual(
      afterBreak(held('b', 7, null)),
    );
    expect(bound('b', [], [other('b', 'q', 3), other('q', 'b', 7)])).toEqual(UNTRUSTED);
    expect(bound('b', [], [other('b', 'q', 5), other('q', 'b', 5)])).toEqual(UNTRUSTED);
  });

  it('ignores a change at or before registration and at or after the window closes', () => {
    const changes = [change('a', 'b', 10)];
    const others = [
      other('q', 'a', -3),
      other('q', 'a', 0),
      other('a', 'q', 10),
      other('q', 'a', 11),
    ];

    expect(bound('b', changes, others)).toEqual(whole(held('a', null, 10), held('b', 10, null)));
  });

  it('matches the address whatever its case', () => {
    const shouting = { before: null, after: 'B@EXAMPLE.TEST', at: day(5) };

    expect(bound('b', [], [shouting])).toEqual(UNTRUSTED);
  });

  it("never moves a window for the player's own changes", () => {
    const changes = [change('a', 'b', 10), change('b', 'a', 20), change('a', 'c', 30)];

    expect(bound('c', changes, changes)).toEqual(windowsOf('c', changes));
  });

  it('leaves a result without a registration window as it is', () => {
    const capped = [1, 2, 3, 4, 5].map((n) => change(`e${n}`, n === 5 ? 'now' : `e${n + 1}`, n));
    const broken = [change('a', 'b', 10), change('x', 'c', 20)];

    expect(bound('now', capped, [other('q', 'e3', 1)])).toEqual(windowsOf('now', capped));
    expect(bound('c', broken, [other('q', 'c', 21)])).toEqual(afterBreak(held('c', 20, null)));
  });
});
