import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SportsbookSessionRow } from '../../schema/index.js';
import { isLiveSession } from '../session.service.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const plus = (ms: number) => new Date(NOW.getTime() + ms);

const session = (over: Partial<SportsbookSessionRow> = {}): SportsbookSessionRow => ({
  id: '33333333-3333-4333-8333-333333333333',
  userId: '22222222-2222-4222-8222-222222222222',
  provider: 'acme-sports',
  currency: 'USD',
  countryCode: 'MT',
  expiresAt: plus(60_000),
  revokedAt: null,
  providerRevokedAt: null,
  providerOpenedAt: NOW,
  providerRevokeAttemptedAt: null,
  createdAt: plus(-60_000),
  ...over,
});

describe('isLiveSession', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each<[string, SportsbookSessionRow | undefined, boolean]>([
    ['a live session of this provider', session(), true],
    ['a session expiring 1ms after now', session({ expiresAt: plus(1) }), true],
    ['a session expiring exactly now', session({ expiresAt: NOW }), false],
    ['a session expired 1ms ago', session({ expiresAt: plus(-1) }), false],
    ['a missing session', undefined, false],
    ['a session of another provider', session({ provider: 'other-sports' }), false],
    ['a session of the provider in another case', session({ provider: 'Acme-sports' }), false],
    ['a session of the provider with padding', session({ provider: 'acme-sports ' }), false],
    ['a revoked session', session({ revokedAt: plus(-1) }), false],
    ['a session revoked in the future', session({ revokedAt: plus(60_000) }), false],
    ['a session the provider alone revoked', session({ providerRevokedAt: plus(-1) }), true],
  ])('%s is %s', (_name, row, expected) => {
    expect(isLiveSession(row, 'acme-sports', NOW)).toBe(expected);
  });

  it('defaults now to the clock', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    expect(isLiveSession(session({ expiresAt: plus(1) }), 'acme-sports')).toBe(true);
    expect(isLiveSession(session({ expiresAt: NOW }), 'acme-sports')).toBe(false);
  });
});
