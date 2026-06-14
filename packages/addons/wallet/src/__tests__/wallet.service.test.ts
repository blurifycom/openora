import { describe, it, expect } from 'vitest';
import { WalletNotFoundError, InsufficientBalanceError } from '../service/wallet.service.js';

describe('WalletService domain errors', () => {
  it('WalletNotFoundError carries the userId', () => {
    const err = new WalletNotFoundError('user-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('WalletNotFoundError');
    expect(err.message).toContain('user-123');
  });

  it('InsufficientBalanceError carries available and requested amounts', () => {
    const err = new InsufficientBalanceError(50, 100);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('InsufficientBalanceError');
    expect(err.message).toContain('50');
    expect(err.message).toContain('100');
  });
});
