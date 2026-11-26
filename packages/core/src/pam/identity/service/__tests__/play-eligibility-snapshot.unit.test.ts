import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { snapshotOf } from '../play-eligibility.service.js';

const USER_ID = '00000000-0000-4000-8000-000000000001';

type State = Parameters<typeof snapshotOf>[1];

const state = (over: Partial<State> = {}): State => ({
  rgBlocked: false,
  rgBlockedUntil: null,
  isActive: true,
  banned: false,
  banExpires: null,
  status: 'active',
  version: 3,
  ...over,
});

describe('snapshotOf', () => {
  it.each([
    [true, true],
    [false, false],
    [null, false],
  ] as const)('reads banned %s as %s', (banned, expected) => {
    expect(snapshotOf(USER_ID, state({ banned })).banned).toBe(expected);
  });

  it('serialises rgBlockedUntil and banExpires to ISO strings', () => {
    const snapshot = snapshotOf(
      USER_ID,
      state({
        rgBlockedUntil: new Date('2026-03-01T10:20:30.456Z'),
        banExpires: new Date('2026-04-02T00:00:00.000Z'),
      }),
    );
    expect(snapshot.rgBlockedUntil).toBe('2026-03-01T10:20:30.456Z');
    expect(snapshot.banExpires).toBe('2026-04-02T00:00:00.000Z');
  });

  it('keeps null dates null', () => {
    const snapshot = snapshotOf(USER_ID, state());
    expect(snapshot.rgBlockedUntil).toBeNull();
    expect(snapshot.banExpires).toBeNull();
  });

  it('carries the user id, flags, status and version through', () => {
    expect(
      snapshotOf(USER_ID, state({ rgBlocked: true, isActive: false, status: null, version: 9 })),
    ).toEqual({
      userId: USER_ID,
      rgBlocked: true,
      rgBlockedUntil: null,
      isActive: false,
      banned: false,
      banExpires: null,
      status: null,
      version: 9,
    });
  });

  it('round trips any block date through ISO text', () => {
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }),
        (date) => {
          const { rgBlockedUntil } = snapshotOf(USER_ID, state({ rgBlockedUntil: date }));
          expect(new Date(rgBlockedUntil ?? '').getTime()).toBe(date.getTime());
        },
      ),
    );
  });
});
