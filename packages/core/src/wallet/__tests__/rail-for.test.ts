import { describe, it, expect } from 'vitest';
import { railFor } from '../service/wallet.service.js';

describe('railFor', () => {
  it.each(['BTC', 'ETH', 'USDT', 'USDC'])('routes %s to the crypto rail', (currency) => {
    expect(railFor(currency)).toBe('crypto');
  });

  it.each(['USD', 'EUR', 'UAH', 'GBP'])('routes %s to the fiat rail', (currency) => {
    expect(railFor(currency)).toBe('fiat');
  });

  it.each(['btc', 'Usdt', 'eTh'])('normalises case before routing %s', (currency) => {
    expect(railFor(currency)).toBe('crypto');
  });

  it('defaults an unknown currency to fiat rather than crypto', () => {
    expect(railFor('XYZ')).toBe('fiat');
    expect(railFor('')).toBe('fiat');
  });

  it('does not treat a currency merely containing a crypto ticker as crypto', () => {
    expect(railFor('BTCX')).toBe('fiat');
    expect(railFor(' BTC')).toBe('fiat');
  });

  it('overrides the built-in set when a custom currency list is passed', () => {
    expect(railFor('SOL', ['SOL', 'XRP'])).toBe('crypto');
    expect(railFor('BTC', ['SOL', 'XRP'])).toBe('fiat');
  });

  it('normalises case in the override list too', () => {
    expect(railFor('sol', ['SOL'])).toBe('crypto');
  });
});
