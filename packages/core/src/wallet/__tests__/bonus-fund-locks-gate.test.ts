import { describe, it, expect } from 'vitest';
import { definePlatformConfig, type BonusFundLockCommands } from '@openora/core/contracts';
import { requireBonusFundLocks } from '../service/wallet.service.js';

const locks: BonusFundLockCommands = {
  lockedFunds: async () => ({ locked: '0', free: '0' }),
  onOutflow: async () => {},
};
const config = (withdrawalWhileActive: 'block' | 'forfeit') =>
  definePlatformConfig({ promo: { bonus: { withdrawalWhileActive } } });

describe('requireBonusFundLocks', () => {
  it('refuses block mode with nothing bound to enforce it', () => {
    expect(() => requireBonusFundLocks(config('block'), undefined)).toThrow(/BONUS_FUND_LOCKS/);
  });

  it('passes the bound port through in block mode', () => {
    expect(requireBonusFundLocks(config('block'), locks)).toBe(locks);
  });

  it('lets forfeit mode and an unbound config run without the port', () => {
    expect(requireBonusFundLocks(config('forfeit'), undefined)).toBeUndefined();
    expect(requireBonusFundLocks(undefined, undefined)).toBeUndefined();
  });
});
