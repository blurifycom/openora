import { describe, it, expect } from 'vitest';
import { isRgBlocked } from '../service/rg-guard.service.js';

const HOUR = 3600_000;

describe('isRgBlocked', () => {
  it('lets an unblocked player through', () => {
    expect(isRgBlocked({ rgBlocked: false, rgBlockedUntil: null })).toBe(false);
  });

  it('blocks indefinitely when no expiry is set', () => {
    expect(isRgBlocked({ rgBlocked: true, rgBlockedUntil: null })).toBe(true);
  });

  it('blocks while the exclusion is still running', () => {
    expect(isRgBlocked({ rgBlocked: true, rgBlockedUntil: new Date(Date.now() + HOUR) })).toBe(
      true,
    );
  });

  it('releases the player once the exclusion has expired', () => {
    expect(isRgBlocked({ rgBlocked: true, rgBlockedUntil: new Date(Date.now() - HOUR) })).toBe(
      false,
    );
  });

  it('ignores a stale expiry when the flag itself is off', () => {
    expect(isRgBlocked({ rgBlocked: false, rgBlockedUntil: new Date(Date.now() + HOUR) })).toBe(
      false,
    );
  });
});
