import { describe, it, expect } from 'vitest';
import {
  resolveWithdrawalNetwork,
  assertAboveMinimumWithdrawal,
  AmbiguousNetworkError,
  UnsupportedNetworkError,
  WithdrawalDisabledError,
  BelowMinimumWithdrawalError,
} from '../service/wallet.service.js';

const asset = (network: string, minWithdrawal = '0', withdrawalEnabled = true) => ({
  network,
  minWithdrawal,
  withdrawalEnabled,
});

describe('resolveWithdrawalNetwork', () => {
  it('passes the caller through when the currency has no catalog rows', () => {
    expect(resolveWithdrawalNetwork([], 'USD', undefined)).toBeNull();
    expect(resolveWithdrawalNetwork([], 'USD', 'sepa')).toBe('SEPA');
  });

  it('implies the only payable network', () => {
    expect(resolveWithdrawalNetwork([asset('ERC20')], 'USDT')).toBe('ERC20');
  });

  it('demands a network when several are payable', () => {
    expect(() => resolveWithdrawalNetwork([asset('ERC20'), asset('TRC20')], 'USDT')).toThrow(
      AmbiguousNetworkError,
    );
  });

  it('implies the only network still payable when the others are disabled', () => {
    const assets = [asset('ERC20'), asset('TRC20', '0', false)];

    expect(resolveWithdrawalNetwork(assets, 'USDT')).toBe('ERC20');
  });

  it('accepts an explicitly chosen payable network, normalizing case', () => {
    const assets = [asset('ERC20'), asset('TRC20')];

    expect(resolveWithdrawalNetwork(assets, 'USDT', 'trc20')).toBe('TRC20');
  });

  it('rejects a network the currency does not settle on', () => {
    expect(() => resolveWithdrawalNetwork([asset('ERC20')], 'USDT', 'BEP20')).toThrow(
      UnsupportedNetworkError,
    );
  });

  it('rejects a network configured but disabled for withdrawal', () => {
    const assets = [asset('ERC20'), asset('TRC20', '0', false)];

    expect(() => resolveWithdrawalNetwork(assets, 'USDT', 'TRC20')).toThrow(
      UnsupportedNetworkError,
    );
  });

  it('fails closed when the currency is configured but payable nowhere', () => {
    const assets = [asset('ERC20', '0', false), asset('TRC20', '0', false)];

    expect(() => resolveWithdrawalNetwork(assets, 'USDT')).toThrow(WithdrawalDisabledError);
    expect(() => resolveWithdrawalNetwork(assets, 'USDT', 'ERC20')).toThrow(
      WithdrawalDisabledError,
    );
  });
});

describe('assertAboveMinimumWithdrawal', () => {
  const assets = [asset('ERC20', '20'), asset('BEP20', '1')];

  it('enforces the floor of the chosen chain, not the currency', () => {
    expect(() => assertAboveMinimumWithdrawal(assets, '5', 'USDT', 'ERC20')).toThrow(
      BelowMinimumWithdrawalError,
    );
    expect(() => assertAboveMinimumWithdrawal(assets, '5', 'USDT', 'BEP20')).not.toThrow();
  });

  it('allows an amount exactly at the floor', () => {
    expect(() => assertAboveMinimumWithdrawal(assets, '20', 'USDT', 'ERC20')).not.toThrow();
  });

  it('is a no-op when the network has no catalog row', () => {
    expect(() => assertAboveMinimumWithdrawal(assets, '0.01', 'USDT', 'TRC20')).not.toThrow();
    expect(() => assertAboveMinimumWithdrawal([], '0.01', 'USD', null)).not.toThrow();
  });
});
