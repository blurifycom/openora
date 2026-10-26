import { describe, it, expect } from 'vitest';
import { SupportHistoryEmailWindowSchema } from '@openora/core/contracts';
import { buildEmailWindows } from '../service/support-history.service.js';

const REGISTERED = new Date('2026-01-01T00:00:00.000Z');
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n));
const iso = (n: number) => day(n).toISOString();

describe('buildEmailWindows', () => {
  it('opens one window from registration for a player who never changed email', () => {
    const windows = buildEmailWindows({
      currentEmail: 'now@example.test',
      registeredAt: REGISTERED,
      changes: [],
    });

    expect(windows).toEqual([
      { email: 'now@example.test', from: REGISTERED.toISOString(), to: null },
    ]);
    expect(windows.every((w) => SupportHistoryEmailWindowSchema.safeParse(w).success)).toBe(true);
  });

  it('closes each previous email at its change and opens the current one at the last', () => {
    expect(
      buildEmailWindows({
        currentEmail: 'third@example.test',
        registeredAt: REGISTERED,
        changes: [
          { email: 'first@example.test', at: day(10) },
          { email: 'second@example.test', at: day(20) },
        ],
      }),
    ).toEqual([
      { email: 'first@example.test', from: REGISTERED.toISOString(), to: iso(10) },
      { email: 'second@example.test', from: iso(10), to: iso(20) },
      { email: 'third@example.test', from: iso(20), to: null },
    ]);
  });

  it('keeps only the three most recent previous emails', () => {
    const changes = [1, 2, 3, 4, 5].map((n) => ({ email: `e${n}@example.test`, at: day(n) }));

    expect(
      buildEmailWindows({ currentEmail: 'now@example.test', registeredAt: REGISTERED, changes }),
    ).toEqual([
      { email: 'e3@example.test', from: iso(2), to: iso(3) },
      { email: 'e4@example.test', from: iso(3), to: iso(4) },
      { email: 'e5@example.test', from: iso(4), to: iso(5) },
      { email: 'now@example.test', from: iso(5), to: null },
    ]);
  });

  it('adds no window for a change without the replaced email, but still ends the one before', () => {
    expect(
      buildEmailWindows({
        currentEmail: 'now@example.test',
        registeredAt: REGISTERED,
        changes: [
          { email: 'first@example.test', at: day(10) },
          { email: null, at: day(20) },
        ],
      }),
    ).toEqual([
      { email: 'first@example.test', from: REGISTERED.toISOString(), to: iso(10) },
      { email: 'now@example.test', from: iso(20), to: null },
    ]);
  });
});
