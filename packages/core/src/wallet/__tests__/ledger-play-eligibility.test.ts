import { describe, it, expect } from 'vitest';
import { playRefusalOf, type PlayEligibilityState } from '@openora/core/contracts';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const LATER = new Date('2026-06-02T12:00:00.000Z');
const EARLIER = new Date('2026-05-31T12:00:00.000Z');

const clear: PlayEligibilityState = {
  rgBlocked: false,
  rgBlockedUntil: null,
  isActive: true,
  banned: false,
  banExpires: null,
  status: 'active',
};

describe('playRefusalOf', () => {
  it('lets a clear account play', () => {
    expect(playRefusalOf(clear, NOW)).toBeNull();
  });

  it('refuses an RG block by its end: none is self-exclusion, a future one cooling-off', () => {
    expect(playRefusalOf({ ...clear, rgBlocked: true }, NOW)).toBe('self_excluded');
    expect(playRefusalOf({ ...clear, rgBlocked: true, rgBlockedUntil: LATER }, NOW)).toBe(
      'cooling_off',
    );
  });

  it('lets a player whose block has ended play before any sweep lifts it', () => {
    expect(playRefusalOf({ ...clear, rgBlocked: true, rgBlockedUntil: EARLIER }, NOW)).toBeNull();
  });

  it('refuses by player status', () => {
    expect(playRefusalOf({ ...clear, status: 'self_excluded' }, NOW)).toBe('self_excluded');
    expect(playRefusalOf({ ...clear, status: 'suspended' }, NOW)).toBe('account_suspended');
    expect(playRefusalOf({ ...clear, status: 'closed' }, NOW)).toBe('account_closed');
  });

  it('refuses an inactive account and a ban until it expires', () => {
    expect(playRefusalOf({ ...clear, isActive: false }, NOW)).toBe('account_inactive');
    expect(playRefusalOf({ ...clear, banned: true }, NOW)).toBe('account_inactive');
    expect(playRefusalOf({ ...clear, banned: true, banExpires: LATER }, NOW)).toBe(
      'account_inactive',
    );
    expect(playRefusalOf({ ...clear, banned: true, banExpires: EARLIER }, NOW)).toBeNull();
  });
});
