import { describe, expect, it } from 'vitest';
import { endedAt, isInForce, latestEnd, ranOutBeforeLift } from '../rg-standing.service.js';

type Row = Parameters<typeof isInForce>[0];

const d = (iso: string) => new Date(iso);
const T0 = d('2026-03-01T00:00:00.000Z');
const EXPIRY = d('2026-03-08T00:00:00.000Z');
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

const row = (over: Partial<Row>): Row => ({
  kind: 'cooling_off',
  status: 'active',
  isPermanent: false,
  startsAt: T0,
  expiresAt: EXPIRY,
  liftedAt: null,
  ...over,
});

describe('isInForce', () => {
  it.each([
    ['lifted', false],
    ['expired', false],
    ['active', true],
  ] as const)('self exclusion with status %s is %s', (status, expected) => {
    expect(isInForce(row({ kind: 'self_exclusion', status, expiresAt: null }), T0)).toBe(expected);
  });

  it('keeps an active self exclusion in force past its expiry', () => {
    expect(isInForce(row({ kind: 'self_exclusion', expiresAt: EXPIRY }), plus(EXPIRY, 1))).toBe(
      true,
    );
  });

  it('keeps a cooling-off in force 1ms before expiresAt', () => {
    expect(isInForce(row({}), plus(EXPIRY, -1))).toBe(true);
  });

  it('ends a cooling-off at expiresAt to the exact millisecond', () => {
    expect(isInForce(row({}), EXPIRY)).toBe(false);
  });

  it('is not in force for a cooling-off without expiresAt', () => {
    expect(isInForce(row({ expiresAt: null }), T0)).toBe(false);
  });

  it('is not in force once the status is not active', () => {
    expect(isInForce(row({ status: 'lifted' }), T0)).toBe(false);
  });
});

describe('ranOutBeforeLift', () => {
  it.each([
    ['lifted after expiry', row({ liftedAt: plus(EXPIRY, 1000) }), true],
    ['lifted at expiry', row({ liftedAt: EXPIRY }), false],
    ['lifted before expiry', row({ liftedAt: plus(EXPIRY, -1000) }), false],
    ['never lifted', row({ liftedAt: null }), false],
    ['no expiry', row({ expiresAt: null, liftedAt: plus(EXPIRY, 1000) }), false],
    [
      'self exclusion lifted after expiry',
      row({ kind: 'self_exclusion', liftedAt: plus(EXPIRY, 1000) }),
      false,
    ],
  ])('%s -> %s', (_name, input, expected) => {
    expect(ranOutBeforeLift(input)).toBe(expected);
  });
});

describe('endedAt', () => {
  const lifted = plus(EXPIRY, -1000);
  const liftedLate = plus(EXPIRY, 1000);

  it('is the lift time when lifted before expiry', () => {
    expect(endedAt(row({ status: 'lifted', liftedAt: lifted }), T0)).toEqual(lifted);
  });

  it('is the expiry when the cooling-off ran out before it was lifted', () => {
    expect(endedAt(row({ status: 'lifted', liftedAt: liftedLate }), T0)).toEqual(EXPIRY);
  });

  it('is the lift time for a lifted self exclusion', () => {
    const input = row({ kind: 'self_exclusion', status: 'lifted', liftedAt: liftedLate });
    expect(endedAt(input, T0)).toEqual(liftedLate);
  });

  it('is the expiry for an expired row', () => {
    expect(endedAt(row({ status: 'expired' }), T0)).toEqual(EXPIRY);
  });

  it('is the expiry for an active cooling-off at expiresAt exactly', () => {
    expect(endedAt(row({}), EXPIRY)).toEqual(EXPIRY);
  });

  it('is null for an active cooling-off 1ms before expiresAt', () => {
    expect(endedAt(row({}), plus(EXPIRY, -1))).toBeNull();
  });

  it('is null for an active self exclusion past its expiresAt', () => {
    expect(endedAt(row({ kind: 'self_exclusion' }), plus(EXPIRY, 1))).toBeNull();
  });

  it('is null for an active self exclusion', () => {
    expect(endedAt(row({ kind: 'self_exclusion', expiresAt: null }), plus(EXPIRY, 1e9))).toBeNull();
  });
});

describe('latestEnd', () => {
  const now = d('2026-06-01T00:00:00.000Z');
  const early = row({ status: 'expired', expiresAt: d('2026-03-08T00:00:00.000Z') });
  const late = row({ status: 'expired', expiresAt: d('2026-04-08T00:00:00.000Z') });

  it('is null without rows', () => {
    expect(latestEnd([], 'cooling_off', now)).toBeNull();
  });

  it('picks the latest end regardless of order', () => {
    expect(latestEnd([late, early], 'cooling_off', now)).toEqual(late.expiresAt);
    expect(latestEnd([early, late], 'cooling_off', now)).toEqual(late.expiresAt);
  });

  it('ignores rows of another kind', () => {
    const other = row({
      kind: 'self_exclusion',
      status: 'lifted',
      liftedAt: d('2026-05-01T00:00:00.000Z'),
    });
    expect(latestEnd([early, other], 'cooling_off', now)).toEqual(early.expiresAt);
  });

  it('ignores rows still in force', () => {
    const active = row({ kind: 'self_exclusion', expiresAt: null });
    expect(latestEnd([active], 'self_exclusion', now)).toBeNull();
  });
});
