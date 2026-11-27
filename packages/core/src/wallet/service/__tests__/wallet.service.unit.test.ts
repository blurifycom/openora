import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { WalletDepositStatusEventStatus } from '@openora/core/contracts';
import { moneyAdd, moneyCompare, moneyEquals, moneySubtract } from '@openora/core/server';
import {
  AmbiguousNetworkError,
  BelowMinimumDepositError,
  BelowMinimumWithdrawalError,
  DepositDisabledError,
  UnsupportedNetworkError,
  WithdrawalAmountNotAboveFeeError,
  WithdrawalDisabledError,
  WithdrawalPrecisionError,
  assertAboveMinimumDeposit,
  assertAboveMinimumWithdrawal,
  assertDepositAllowed,
  assertPayablePrecision,
  balanceKey,
  depositFloor,
  depositStatusIsNoOp,
  isAddressCurrencyMismatch,
  isRecordableDeposit,
  namespacedIdempotencyKey,
  payoutAmount,
  resolveWithdrawalNetwork,
  soleNetworkForCurrency,
  withdrawalFeeFor,
} from '../wallet.service.js';

const UNIT = '0.000000000000000001';

type WithdrawalAssetFixture = {
  network: string;
  minWithdrawal: string;
  withdrawalFee?: string;
  withdrawalEnabled: boolean;
};

type DepositAssetFixture = {
  network: string;
  minDeposit: string;
  depositEnabled: boolean;
};

const wAsset = (over: Partial<WithdrawalAssetFixture> = {}): WithdrawalAssetFixture => ({
  network: 'TRC20',
  minWithdrawal: '10',
  withdrawalEnabled: true,
  ...over,
});

const dAsset = (over: Partial<DepositAssetFixture> = {}): DepositAssetFixture => ({
  network: 'TRC20',
  minDeposit: '10',
  depositEnabled: true,
  ...over,
});

const moneyArb = fc.bigInt({ min: 0n, max: 10n ** 30n }).map((units) => {
  const whole = (units / 10n ** 18n).toString();
  const fraction = (units % 10n ** 18n).toString().padStart(18, '0');
  return `${whole}.${fraction}`;
});

describe('resolveWithdrawalNetwork', () => {
  it('passes the caller choice through, uppercased, when the catalog is empty', () => {
    expect(resolveWithdrawalNetwork([], 'USDT', 'trc20')).toBe('TRC20');
    expect(resolveWithdrawalNetwork([], 'EUR')).toBeNull();
  });

  it('fails closed when every row is withdrawal-disabled', () => {
    const assets = [wAsset({ withdrawalEnabled: false })];
    expect(() => resolveWithdrawalNetwork(assets, 'USDT')).toThrow(WithdrawalDisabledError);
    expect(() => resolveWithdrawalNetwork(assets, 'USDT', 'TRC20')).toThrow(
      WithdrawalDisabledError,
    );
  });

  it('implies the only payable network and uppercases it', () => {
    const assets = [
      wAsset({ network: 'erc20' }),
      wAsset({ network: 'TRC20', withdrawalEnabled: false }),
    ];
    expect(resolveWithdrawalNetwork(assets, 'USDT')).toBe('ERC20');
  });

  it('demands a network when several are payable', () => {
    const assets = [wAsset({ network: 'TRC20' }), wAsset({ network: 'ERC20' })];
    expect(() => resolveWithdrawalNetwork(assets, 'USDT')).toThrow(AmbiguousNetworkError);
  });

  it('refuses a named network that is disabled or unknown', () => {
    const assets = [
      wAsset({ network: 'TRC20' }),
      wAsset({ network: 'ERC20', withdrawalEnabled: false }),
    ];
    expect(() => resolveWithdrawalNetwork(assets, 'USDT', 'ERC20')).toThrow(
      UnsupportedNetworkError,
    );
    expect(() => resolveWithdrawalNetwork(assets, 'USDT', 'SOL')).toThrow(UnsupportedNetworkError);
  });

  it('matches the network name case-insensitively and returns it uppercased', () => {
    const assets = [wAsset({ network: 'Trc20' }), wAsset({ network: 'ERC20' })];
    expect(resolveWithdrawalNetwork(assets, 'USDT', 'tRc20')).toBe('TRC20');
  });
});

describe('assertAboveMinimumWithdrawal', () => {
  const assets = [
    wAsset({ network: 'TRC20', minWithdrawal: '10' }),
    wAsset({ network: 'ERC20', minWithdrawal: '50' }),
  ];

  it('passes exactly at the minimum and fails one smallest unit below', () => {
    expect(() => assertAboveMinimumWithdrawal(assets, '10', 'USDT', 'TRC20')).not.toThrow();
    expect(() => assertAboveMinimumWithdrawal(assets, '10.000', 'USDT', 'TRC20')).not.toThrow();
    expect(() =>
      assertAboveMinimumWithdrawal(assets, moneySubtract('10', UNIT), 'USDT', 'TRC20'),
    ).toThrow(BelowMinimumWithdrawalError);
  });

  it('applies the floor of the chosen network, not of another', () => {
    expect(() => assertAboveMinimumWithdrawal(assets, '20', 'USDT', 'ERC20')).toThrow(
      BelowMinimumWithdrawalError,
    );
  });

  it('does not check a disabled network or a null network', () => {
    const disabled = [wAsset({ minWithdrawal: '10', withdrawalEnabled: false })];
    expect(() => assertAboveMinimumWithdrawal(disabled, '1', 'USDT', 'TRC20')).not.toThrow();
    expect(() => assertAboveMinimumWithdrawal(assets, '1', 'USDT', null)).not.toThrow();
  });

  it('agrees with moneyCompare for any amount and floor', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (amount, floor) => {
        const rows = [wAsset({ minWithdrawal: floor })];
        const throws = (() => {
          try {
            assertAboveMinimumWithdrawal(rows, amount, 'USDT', 'TRC20');
            return false;
          } catch {
            return true;
          }
        })();
        expect(throws).toBe(moneyCompare(amount, floor) < 0);
      }),
    );
  });
});

describe('depositFloor and assertAboveMinimumDeposit', () => {
  const assets = [
    dAsset({ network: 'TRC20', minDeposit: '5' }),
    dAsset({ network: 'ERC20', minDeposit: '20' }),
    dAsset({ network: 'BEP20', minDeposit: '1', depositEnabled: false }),
  ];

  it('picks the lowest floor among the rows given', () => {
    expect(depositFloor(assets)?.network).toBe('BEP20');
    expect(depositFloor([])).toBeUndefined();
  });

  it('narrows to the named network case-insensitively', () => {
    expect(depositFloor(assets, 'erc20')?.minDeposit).toBe('20');
    expect(depositFloor(assets, 'SOL')).toBeUndefined();
  });

  it('ignores disabled rows when asserting the minimum', () => {
    expect(() => assertAboveMinimumDeposit(assets, '2', 'USDT')).toThrow(BelowMinimumDepositError);
    expect(() => assertAboveMinimumDeposit(assets, '5', 'USDT')).not.toThrow();
  });

  it('passes exactly at the floor and fails one unit below', () => {
    expect(() => assertAboveMinimumDeposit(assets, '20', 'USDT', 'ERC20')).not.toThrow();
    expect(() =>
      assertAboveMinimumDeposit(assets, moneySubtract('20', UNIT), 'USDT', 'ERC20'),
    ).toThrow(BelowMinimumDepositError);
  });

  it('does not enforce a floor for a disabled named network', () => {
    expect(() => assertAboveMinimumDeposit(assets, '0.5', 'USDT', 'BEP20')).not.toThrow();
  });

  it('applies the floor of the named network even when another is lower', () => {
    expect(() => assertAboveMinimumDeposit(assets, '10', 'USDT', 'ERC20')).toThrow(
      BelowMinimumDepositError,
    );
  });
});

describe('assertDepositAllowed', () => {
  it('passes a currency-level request when no catalog exists', () => {
    expect(() => assertDepositAllowed([], 'EUR')).not.toThrow();
  });

  it('fails closed when a network is named but no catalog exists', () => {
    expect(() => assertDepositAllowed([], 'USDT', 'trc20')).toThrow(UnsupportedNetworkError);
  });

  it('refuses a currency whose every row is deposit-disabled', () => {
    expect(() => assertDepositAllowed([dAsset({ depositEnabled: false })], 'USDT')).toThrow(
      DepositDisabledError,
    );
  });

  it('allows a currency-level request when one row is enabled', () => {
    const assets = [dAsset({ depositEnabled: false }), dAsset({ network: 'ERC20' })];
    expect(() => assertDepositAllowed(assets, 'USDT')).not.toThrow();
  });

  it('refuses an unknown or disabled named network, case-insensitively', () => {
    const assets = [
      dAsset({ network: 'TRC20' }),
      dAsset({ network: 'ERC20', depositEnabled: false }),
    ];
    expect(() => assertDepositAllowed(assets, 'USDT', 'trc20')).not.toThrow();
    expect(() => assertDepositAllowed(assets, 'USDT', 'erc20')).toThrow(DepositDisabledError);
    expect(() => assertDepositAllowed(assets, 'USDT', 'sol')).toThrow(UnsupportedNetworkError);
  });
});

describe('withdrawalFeeFor', () => {
  const feeAsset = (fee: string | undefined) => [wAsset({ withdrawalFee: fee })];

  it.each([undefined, '0', '0.000', '-1', '-0.5'])('charges nothing for fee %s', (fee) => {
    expect(withdrawalFeeFor(feeAsset(fee), '100', 'USDT', 'TRC20')).toBeNull();
  });

  it('returns the fee when the amount is above it', () => {
    expect(withdrawalFeeFor(feeAsset('2'), '100', 'USDT', 'TRC20')).toBe('2');
  });

  it('refuses an amount equal to or below the fee', () => {
    expect(() => withdrawalFeeFor(feeAsset('2'), '2', 'USDT', 'TRC20')).toThrow(
      WithdrawalAmountNotAboveFeeError,
    );
    expect(() => withdrawalFeeFor(feeAsset('2'), '2.00', 'USDT', 'TRC20')).toThrow(
      WithdrawalAmountNotAboveFeeError,
    );
    expect(() => withdrawalFeeFor(feeAsset('2'), '1', 'USDT', 'TRC20')).toThrow(
      WithdrawalAmountNotAboveFeeError,
    );
  });

  it('accepts fee plus one smallest unit and pays out exactly one unit', () => {
    const amount = moneyAdd('2', UNIT);
    const fee = withdrawalFeeFor(feeAsset('2'), amount, 'USDT', 'TRC20');
    expect(fee).toBe('2');
    expect(moneyEquals(payoutAmount({ amount, fee }), UNIT)).toBe(true);
  });

  it('charges nothing on a disabled or unmatched network', () => {
    expect(
      withdrawalFeeFor(
        [wAsset({ withdrawalFee: '2', withdrawalEnabled: false })],
        '1',
        'USDT',
        'TRC20',
      ),
    ).toBeNull();
    expect(withdrawalFeeFor(feeAsset('2'), '1', 'USDT', null)).toBeNull();
  });

  it('keeps payout plus fee equal to the debit for any accepted amount', () => {
    fc.assert(
      fc.property(moneyArb, moneyArb, (amount, feeValue) => {
        const rows = feeAsset(feeValue);
        if (moneyCompare(feeValue, '0') <= 0) {
          return;
        }
        if (moneyCompare(amount, feeValue) <= 0) {
          expect(() => withdrawalFeeFor(rows, amount, 'USDT', 'TRC20')).toThrow(
            WithdrawalAmountNotAboveFeeError,
          );
          return;
        }
        const fee = withdrawalFeeFor(rows, amount, 'USDT', 'TRC20');
        const payout = payoutAmount({ amount, fee });
        expect(moneyCompare(payout, '0')).toBe(1);
        expect(moneyEquals(moneyAdd(payout, fee ?? '0'), amount)).toBe(true);
      }),
    );
  });
});

describe('payoutAmount', () => {
  it('is the amount when there is no fee', () => {
    expect(payoutAmount({ amount: '12.5', fee: null })).toBe('12.5');
  });

  it('subtracts the fee exactly', () => {
    expect(
      moneyEquals(
        payoutAmount({ amount: '10', fee: '0.000000000000000001' }),
        '9.999999999999999999',
      ),
    ).toBe(true);
  });
});

describe('assertPayablePrecision', () => {
  it('passes for any amount when decimals is null', () => {
    expect(() =>
      assertPayablePrecision(null, ['0.1234567890123456789'], 'BTC', 'BTC'),
    ).not.toThrow();
  });

  it('refuses 7 fractional digits at 6 decimals and accepts 6', () => {
    expect(() => assertPayablePrecision(6, ['1.1234567'], 'USDT', 'TRC20')).toThrow(
      WithdrawalPrecisionError,
    );
    expect(() => assertPayablePrecision(6, ['1.123456'], 'USDT', 'TRC20')).not.toThrow();
  });

  it('ignores trailing zeros', () => {
    expect(() => assertPayablePrecision(6, ['1.1234560000'], 'USDT', 'TRC20')).not.toThrow();
    expect(() => assertPayablePrecision(0, ['5.000'], 'USDT', 'TRC20')).not.toThrow();
    expect(() => assertPayablePrecision(0, ['5.1'], 'USDT', 'TRC20')).toThrow(
      WithdrawalPrecisionError,
    );
  });

  it('checks every amount and skips null entries', () => {
    expect(() => assertPayablePrecision(2, ['1.25', null], 'EUR', 'X')).not.toThrow();
    expect(() => assertPayablePrecision(2, ['1.25', '0.001'], 'EUR', 'X')).toThrow(
      WithdrawalPrecisionError,
    );
    expect(() => assertPayablePrecision(2, ['0.001', '1.25'], 'EUR', 'X')).toThrow(
      WithdrawalPrecisionError,
    );
  });

  it('refuses a payout that a fee pushes past the precision', () => {
    expect(() => assertPayablePrecision(6, ['10', '0.0000001'], 'USDT', 'TRC20')).toThrow(
      WithdrawalPrecisionError,
    );
  });

  it('accepts exactly the amounts with at most `decimals` significant fraction digits', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 18 }), moneyArb, (decimals, amount) => {
        const significant = (amount.split('.')[1] ?? '').replace(/0+$/, '').length;
        const throws = (() => {
          try {
            assertPayablePrecision(decimals, [amount], 'X', 'Y');
            return false;
          } catch {
            return true;
          }
        })();
        expect(throws).toBe(significant > decimals);
      }),
    );
  });
});

describe('deposit event rules', () => {
  const seen = (...statuses: WalletDepositStatusEventStatus[]) => new Set(statuses);

  it.each([
    [[], 'detected', false],
    [[], 'failed', false],
    [[], 'below_minimum', false],
    [['detected'], 'detected', true],
    [['failed'], 'failed', true],
    [['below_minimum'], 'detected', true],
    [['below_minimum'], 'failed', true],
    [['below_minimum'], 'below_minimum', true],
    [['failed'], 'detected', true],
    [['detected'], 'failed', false],
    [['detected'], 'below_minimum', false],
    [['failed'], 'below_minimum', false],
  ] as const)('seen %j then %s is a no-op: %s', (history, status, expected) => {
    expect(depositStatusIsNoOp(seen(...history), status)).toBe(expected);
  });

  it('treats a repeat of any status as a no-op', () => {
    for (const status of ['detected', 'failed', 'below_minimum'] as const) {
      expect(depositStatusIsNoOp(seen(status), status)).toBe(true);
    }
  });

  it.each(['', ' ', '   ', '\t', '\n'])('refuses blank externalId %j', (externalId) => {
    expect(isRecordableDeposit({ externalId, amount: '1' })).toBe(false);
  });

  it('records a real id with a valid amount', () => {
    expect(isRecordableDeposit({ externalId: 'tx-1', amount: '1.5' })).toBe(true);
  });

  it.each(['', 'abc', '-1', '1e3', '1.', '.5', '1.0000000000000000001', '1,5', ' 1'])(
    'refuses malformed amount %j',
    (amount) => {
      expect(isRecordableDeposit({ externalId: 'tx-1', amount })).toBe(false);
    },
  );

  it.each(['0', '0.0'])(
    'records a zero-value deposit %s so the minimum check files it as below minimum',
    (amount) => {
      expect(isRecordableDeposit({ externalId: 'tx-1', amount })).toBe(true);
    },
  );
});

describe('soleNetworkForCurrency', () => {
  const row = (currency: string, network: string | null) => ({ currency, network });

  it('returns the network when exactly one row matches the currency', () => {
    expect(soleNetworkForCurrency([row('USDT', 'TRC20'), row('BTC', 'BTC')], 'usdt')).toBe('TRC20');
  });

  it('returns undefined for none, several, or a null network', () => {
    expect(soleNetworkForCurrency([], 'USDT')).toBeUndefined();
    expect(
      soleNetworkForCurrency([row('USDT', 'TRC20'), row('usdt', 'ERC20')], 'USDT'),
    ).toBeUndefined();
    expect(soleNetworkForCurrency([row('USDT', null)], 'USDT')).toBeUndefined();
  });
});

describe('balanceKey', () => {
  it('uppercases and is idempotent', () => {
    expect(balanceKey('usdt')).toBe('USDT');
    fc.assert(
      fc.property(fc.string(), (currency) => {
        expect(balanceKey(balanceKey(currency))).toBe(balanceKey(currency));
      }),
    );
  });
});

describe('namespacedIdempotencyKey', () => {
  it('is deterministic and shaped like a uuid', () => {
    fc.assert(
      fc.property(
        fc.string().filter((value) => !value.includes(':')),
        fc.string(),
        (namespace, raw) => {
          const key = namespacedIdempotencyKey(namespace, raw);
          expect(key).toBe(namespacedIdempotencyKey(namespace, raw));
          expect(key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        },
      ),
    );
  });

  it('separates namespaces for an equal raw key', () => {
    expect(namespacedIdempotencyKey('deposit', 'k')).not.toBe(
      namespacedIdempotencyKey('withdrawal', 'k'),
    );
  });

  it('refuses a namespace with the separator in it, so the split cannot move', () => {
    expect(() => namespacedIdempotencyKey('a:b', 'c')).toThrow(RangeError);
    expect(() => namespacedIdempotencyKey('a', 'b:c')).not.toThrow();
  });

  it('keeps the key every stored row was written with', () => {
    expect(namespacedIdempotencyKey('deposit', '00000000-0000-4000-8000-000000000000')).toBe(
      '0ffa6dcf-5bb0-3851-7c3f-16c08dd73787',
    );
  });
});

describe('isAddressCurrencyMismatch', () => {
  const mismatch = (network: string | undefined, eventCurrency: string, addressCurrency: string) =>
    isAddressCurrencyMismatch(
      { network, currency: eventCurrency } as never,
      { currency: addressCurrency } as never,
    );

  it('is false when the currencies match', () => {
    expect(mismatch(undefined, 'USDT', 'USDT')).toBe(false);
  });

  it('ignores currency case', () => {
    expect(mismatch(undefined, 'usdt', 'USDT')).toBe(false);
  });

  it('is true for different currencies without a network', () => {
    expect(mismatch(undefined, 'BTC', 'USDT')).toBe(true);
  });

  it('is false whenever the event names a network', () => {
    expect(mismatch('tron', 'BTC', 'USDT')).toBe(false);
  });
});
