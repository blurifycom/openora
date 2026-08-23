import { describe, it, expect } from 'vitest';
import {
  assertDepositAllowed,
  assertAboveMinimumDeposit,
  DepositDisabledError,
  BelowMinimumDepositError,
  UnsupportedNetworkError,
} from '../service/wallet.service.js';

const asset = (network: string, depositEnabled: boolean, minDeposit = '10') => ({
  network,
  minDeposit,
  depositEnabled,
});

describe('assertDepositAllowed', () => {
  it('passes an unconfigured currency through (fiat PSP)', () => {
    expect(() => assertDepositAllowed([], 'USD')).not.toThrow();
    expect(() => assertDepositAllowed([], 'USD', 'SEPA')).not.toThrow();
  });

  it('rejects a named network that is disabled', () => {
    expect(() => assertDepositAllowed([asset('ERC20', false)], 'USDT', 'erc20')).toThrow(
      DepositDisabledError,
    );
  });

  it('rejects a named network with no catalog row', () => {
    expect(() => assertDepositAllowed([asset('ERC20', true)], 'USDT', 'TRC20')).toThrow(
      UnsupportedNetworkError,
    );
  });

  it('rejects a currency whose every network is disabled', () => {
    expect(() =>
      assertDepositAllowed([asset('ERC20', false), asset('TRC20', false)], 'USDT'),
    ).toThrow(DepositDisabledError);
  });

  it('allows a currency with at least one enabled network', () => {
    expect(() =>
      assertDepositAllowed([asset('ERC20', false), asset('TRC20', true)], 'USDT'),
    ).not.toThrow();
  });
});

describe('assertAboveMinimumDeposit', () => {
  const assets = [
    asset('ERC20', true, '25'),
    asset('TRC20', true, '5'),
    asset('BEP20', false, '1'),
  ];

  it('applies the named chain floor', () => {
    expect(() => assertAboveMinimumDeposit(assets, '10', 'USDT', 'ERC20')).toThrow(
      BelowMinimumDepositError,
    );
    expect(() => assertAboveMinimumDeposit(assets, '10', 'USDT', 'TRC20')).not.toThrow();
  });

  it('applies the lowest enabled floor when no chain is named', () => {
    expect(() => assertAboveMinimumDeposit(assets, '5', 'USDT')).not.toThrow();
    expect(() => assertAboveMinimumDeposit(assets, '4.999999999999999999', 'USDT')).toThrow(
      BelowMinimumDepositError,
    );
  });

  it('ignores a disabled network floor', () => {
    expect(() => assertAboveMinimumDeposit(assets, '2', 'USDT')).toThrow(BelowMinimumDepositError);
  });
});
