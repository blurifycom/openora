import { describe, expect, it } from 'vitest';
import { MoneyAmountSchema, resolveWalletReferenceCurrency } from '@openora/core/contracts';
import {
  isPositiveMoney,
  moneyAdd,
  moneyCompare,
  moneyEquals,
  moneyFloorToScale,
  moneyScaleBy,
  moneySubtract,
} from '@openora/core/server';
import { isWalletAddressValidForNetwork } from '../contract/index.js';
import {
  assertAboveMinimumDeposit,
  assertAboveMinimumWithdrawal,
  assertPayablePrecision,
  BelowMinimumDepositError,
  BelowMinimumWithdrawalError,
  depositFloor,
  payoutAmount,
  resolveWithdrawalNetwork,
  soleNetworkForCurrency,
  UnsupportedNetworkError,
  WithdrawalAmountNotAboveFeeError,
  WithdrawalPrecisionError,
  withdrawalFeeFor,
} from '../service/wallet.service.js';

const P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4';
const P2WSH = 'bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3';
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';
const XRP = 'rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh';

describe('isWalletAddressValidForNetwork', () => {
  it('accepts a valid P2PKH, P2SH and bech32 address for BTC', () => {
    expect(isWalletAddressValidForNetwork(P2PKH, 'SEGWIT')).toBe(true);
    expect(isWalletAddressValidForNetwork(P2SH, 'SEGWIT')).toBe(true);
    expect(isWalletAddressValidForNetwork(P2WSH, 'SEGWIT')).toBe(true);
  });

  it('accepts a short P2WPKH BTC address', () => {
    expect(P2WPKH).toHaveLength(42);
    expect(isWalletAddressValidForNetwork(P2WPKH, 'SEGWIT')).toBe(true);
  });

  it('rejects a bech32 address with a bad checksum', () => {
    const lastChar = P2WPKH.slice(-1);
    const corrupted = `${P2WPKH.slice(0, -1)}${lastChar === 'q' ? 'p' : 'q'}`;
    expect(isWalletAddressValidForNetwork(corrupted, 'SEGWIT')).toBe(false);
    const swapped = `${P2WPKH.slice(0, 10)}${P2WPKH[11]}${P2WPKH[10]}${P2WPKH.slice(12)}`;
    expect(isWalletAddressValidForNetwork(swapped, 'SEGWIT')).toBe(false);
    expect(isWalletAddressValidForNetwork(P2WPKH.slice(0, -2), 'SEGWIT')).toBe(false);
  });

  it('rejects a BTC address with a wrong prefix or illegal characters', () => {
    expect(isWalletAddressValidForNetwork(`4${P2PKH.slice(1)}`, 'SEGWIT')).toBe(false);
    expect(isWalletAddressValidForNetwork(`${P2PKH.slice(0, -1)}0`, 'SEGWIT')).toBe(false);
    expect(isWalletAddressValidForNetwork(`${P2PKH.slice(0, -1)}l`, 'SEGWIT')).toBe(false);
    expect(isWalletAddressValidForNetwork(`ltc1${P2WPKH.slice(4)}`, 'SEGWIT')).toBe(false);
    expect(isWalletAddressValidForNetwork(P2WPKH.toUpperCase(), 'SEGWIT')).toBe(false);
  });

  it('accepts a valid EVM address and rejects a wrong length or non-hex one', () => {
    expect(isWalletAddressValidForNetwork(EVM, 'ERC20')).toBe(true);
    expect(isWalletAddressValidForNetwork(EVM, 'BEP20')).toBe(true);
    expect(isWalletAddressValidForNetwork(EVM.slice(0, -1), 'ERC20')).toBe(false);
    expect(isWalletAddressValidForNetwork(`${EVM}0`, 'ERC20')).toBe(false);
    expect(isWalletAddressValidForNetwork(`${EVM.slice(0, -1)}G`, 'ERC20')).toBe(false);
    expect(isWalletAddressValidForNetwork(EVM.slice(2), 'ERC20')).toBe(false);
  });

  it('accepts a valid XRP ledger address and rejects one outside the length bound', () => {
    expect(isWalletAddressValidForNetwork(XRP, 'XRP_LEDGER')).toBe(true);
    expect(isWalletAddressValidForNetwork(`r${'a'.repeat(24)}`, 'XRP_LEDGER')).toBe(true);
    expect(isWalletAddressValidForNetwork(`r${'a'.repeat(23)}`, 'XRP_LEDGER')).toBe(false);
    expect(isWalletAddressValidForNetwork(`r${'a'.repeat(35)}`, 'XRP_LEDGER')).toBe(false);
    expect(isWalletAddressValidForNetwork(`x${XRP.slice(1)}`, 'XRP_LEDGER')).toBe(false);
  });

  it('looks the network up case-insensitively', () => {
    expect(isWalletAddressValidForNetwork(EVM, 'erc20')).toBe(true);
    expect(isWalletAddressValidForNetwork(EVM.slice(0, -1), 'erc20')).toBe(false);
    expect(isWalletAddressValidForNetwork(XRP, 'xrp_ledger')).toBe(true);
  });

  it('accepts any address of 8 to 128 characters for a network with no pattern', () => {
    expect(isWalletAddressValidForNetwork('a'.repeat(8), 'UNKNOWN_CHAIN')).toBe(true);
    expect(isWalletAddressValidForNetwork('!'.repeat(128), 'UNKNOWN_CHAIN')).toBe(true);
  });

  it('rejects an address shorter than 8 or longer than 128 characters for a network with no pattern', () => {
    expect(isWalletAddressValidForNetwork('a'.repeat(7), 'UNKNOWN_CHAIN')).toBe(false);
    expect(isWalletAddressValidForNetwork('a'.repeat(129), 'UNKNOWN_CHAIN')).toBe(false);
    expect(isWalletAddressValidForNetwork('', 'UNKNOWN_CHAIN')).toBe(false);
  });
});

const erc20 = {
  network: 'ERC20',
  minWithdrawal: '20',
  withdrawalFee: '5.5',
  withdrawalEnabled: true,
};
const bep20 = {
  network: 'BEP20',
  minWithdrawal: '2',
  withdrawalFee: '0.3',
  withdrawalEnabled: true,
};
const usdtAssets = [erc20, bep20];

describe('withdrawal minimum', () => {
  it('refuses an amount below the asset minimum', () => {
    expect(() =>
      assertAboveMinimumWithdrawal(usdtAssets, '19.999999999999999999', 'USDT', 'ERC20'),
    ).toThrow(BelowMinimumWithdrawalError);
    expect(() => assertAboveMinimumWithdrawal(usdtAssets, '0', 'USDT', 'ERC20')).toThrow(
      BelowMinimumWithdrawalError,
    );
  });

  it('accepts an amount equal to the asset minimum', () => {
    expect(() => assertAboveMinimumWithdrawal(usdtAssets, '20', 'USDT', 'ERC20')).not.toThrow();
    expect(() => assertAboveMinimumWithdrawal(usdtAssets, '20.00', 'USDT', 'ERC20')).not.toThrow();
    expect(() =>
      assertAboveMinimumWithdrawal(usdtAssets, '20.000000000000000001', 'USDT', 'ERC20'),
    ).not.toThrow();
  });

  it('passes a currency-level request when the currency has no catalog row', () => {
    expect(resolveWithdrawalNetwork([], 'EUR')).toBeNull();
    expect(() => assertAboveMinimumWithdrawal([], '0.01', 'EUR', null)).not.toThrow();
  });

  it('refuses a request naming a network that has no catalog row', () => {
    expect(() => resolveWithdrawalNetwork(usdtAssets, 'USDT', 'TRC20')).toThrow(
      UnsupportedNetworkError,
    );
    const disabledOnly = [{ ...erc20, withdrawalEnabled: false }, bep20];
    expect(() => resolveWithdrawalNetwork(disabledOnly, 'USDT', 'ERC20')).toThrow(
      UnsupportedNetworkError,
    );
  });

  it('uses the row of the named network when several networks exist', () => {
    expect(resolveWithdrawalNetwork(usdtAssets, 'USDT', 'bep20')).toBe('BEP20');
    expect(() => assertAboveMinimumWithdrawal(usdtAssets, '2', 'USDT', 'BEP20')).not.toThrow();
    expect(() => assertAboveMinimumWithdrawal(usdtAssets, '2', 'USDT', 'ERC20')).toThrow(
      BelowMinimumWithdrawalError,
    );
  });
});

describe('withdrawal fee', () => {
  it('returns the fee of the named network row', () => {
    expect(withdrawalFeeFor(usdtAssets, '100', 'USDT', 'ERC20')).toBe('5.5');
    expect(withdrawalFeeFor(usdtAssets, '100', 'USDT', 'BEP20')).toBe('0.3');
  });

  it('returns zero when the asset has no fee', () => {
    const trc20 = { network: 'TRC20', minWithdrawal: '1', withdrawalEnabled: true };
    const noFee = [trc20];
    const zeroFee = [{ ...trc20, withdrawalFee: '0.000' }];
    expect(withdrawalFeeFor(noFee, '1', 'USDT', 'TRC20')).toBeNull();
    expect(withdrawalFeeFor(zeroFee, '1', 'USDT', 'TRC20')).toBeNull();
    expect(withdrawalFeeFor([], '1', 'EUR', null)).toBeNull();
  });

  it('refuses an amount equal to or below the fee', () => {
    expect(() => withdrawalFeeFor(usdtAssets, '5.5', 'USDT', 'ERC20')).toThrow(
      WithdrawalAmountNotAboveFeeError,
    );
    expect(() => withdrawalFeeFor(usdtAssets, '5.499999999999999999', 'USDT', 'ERC20')).toThrow(
      WithdrawalAmountNotAboveFeeError,
    );
    expect(withdrawalFeeFor(usdtAssets, '5.500000000000000001', 'USDT', 'ERC20')).toBe('5.5');
  });

  it('computes the net payout as amount minus fee without float rounding', () => {
    expect(payoutAmount({ amount: '0.3', fee: '0.1' })).toBe('0.200000000000000000');
    expect(payoutAmount({ amount: '1.000000000000000001', fee: '0.000000000000000001' })).toBe(
      '1.000000000000000000',
    );
    expect(payoutAmount({ amount: '100', fee: null })).toBe('100');
  });
});

describe('payable precision', () => {
  it('accepts an amount with at most the asset decimals', () => {
    expect(() =>
      assertPayablePrecision(6, ['1.123456', '0.5', '3'], 'USDT', 'ERC20'),
    ).not.toThrow();
    expect(() => assertPayablePrecision(0, ['7'], 'XRP', 'XRP_LEDGER')).not.toThrow();
    expect(() => assertPayablePrecision(6, ['1.1234567', null], 'USDT', 'ERC20')).toThrow(
      WithdrawalPrecisionError,
    );
  });

  it('refuses an amount with more decimals than the asset allows and never rounds it', () => {
    expect(() => assertPayablePrecision(6, ['1.1234567'], 'USDT', 'ERC20')).toThrow(
      WithdrawalPrecisionError,
    );
    expect(() => assertPayablePrecision(6, ['1.1234564'], 'USDT', 'ERC20')).toThrow(
      WithdrawalPrecisionError,
    );
    expect(() => assertPayablePrecision(6, ['1', '0.0000001'], 'USDT', 'ERC20')).toThrow(
      WithdrawalPrecisionError,
    );
    expect(() => assertPayablePrecision(0, ['1.5'], 'XRP', 'XRP_LEDGER')).toThrow(
      WithdrawalPrecisionError,
    );
  });

  it('treats trailing zeros beyond the allowed decimals as valid', () => {
    expect(() =>
      assertPayablePrecision(6, ['1.123456000000000000'], 'USDT', 'ERC20'),
    ).not.toThrow();
    expect(() => assertPayablePrecision(0, ['5.000'], 'XRP', 'XRP_LEDGER')).not.toThrow();
    expect(() => assertPayablePrecision(null, ['1.123456789'], 'EUR', 'X')).not.toThrow();
  });
});

const depositRows = [
  { network: 'ERC20', minDeposit: '10', depositEnabled: true },
  { network: 'BEP20', minDeposit: '1', depositEnabled: true },
  { network: 'TRC20', minDeposit: '5', depositEnabled: true },
];

describe('deposit minimum', () => {
  it.todo('refuses a zero amount whatever the floor');

  it('refuses an amount below the minimum of the event network row', () => {
    expect(depositFloor(depositRows, 'erc20')?.minDeposit).toBe('10');
    expect(() => assertAboveMinimumDeposit(depositRows, '9.99', 'USDT', 'ERC20')).toThrow(
      BelowMinimumDepositError,
    );
    expect(() => assertAboveMinimumDeposit(depositRows, '9.99', 'USDT', 'BEP20')).not.toThrow();
  });

  it('uses the row of the one network the address was issued on when the event names none', () => {
    const issued = [{ currency: 'USDT', network: 'ERC20' }];
    const network = soleNetworkForCurrency(issued, 'usdt');
    expect(network).toBe('ERC20');
    expect(depositFloor(depositRows, network)?.minDeposit).toBe('10');
    expect(
      soleNetworkForCurrency([{ currency: 'BTC', network: 'SEGWIT' }], 'USDT'),
    ).toBeUndefined();
  });

  it('uses the lowest row when the address has no row or several for that currency', () => {
    const several = [
      { currency: 'USDT', network: 'ERC20' },
      { currency: 'USDT', network: 'BEP20' },
    ];
    expect(soleNetworkForCurrency([], 'USDT')).toBeUndefined();
    expect(soleNetworkForCurrency(several, 'USDT')).toBeUndefined();
    expect(depositFloor(depositRows, undefined)).toEqual(depositRows[1]);
    expect(depositFloor(depositRows, 'SOLANA')).toBeUndefined();
  });

  it('counts a row with deposits switched off as the floor', () => {
    const rows = [
      { network: 'ERC20', minDeposit: '10', depositEnabled: true },
      { network: 'BEP20', minDeposit: '0.5', depositEnabled: false },
    ];
    expect(depositFloor(rows)?.network).toBe('BEP20');
    expect(depositFloor(rows)?.minDeposit).toBe('0.5');
  });

  it('accepts an amount equal to the minimum', () => {
    expect(() => assertAboveMinimumDeposit(depositRows, '10', 'USDT', 'ERC20')).not.toThrow();
    expect(() => assertAboveMinimumDeposit(depositRows, '10.00', 'USDT', 'ERC20')).not.toThrow();
    expect(() => assertAboveMinimumDeposit(depositRows, '1', 'USDT')).not.toThrow();
    expect(() => assertAboveMinimumDeposit(depositRows, '0.999999999999999999', 'USDT')).toThrow(
      BelowMinimumDepositError,
    );
  });
});

describe('decimal money math', () => {
  it('adds and subtracts amounts without binary float error', () => {
    expect(0.1 + 0.2).not.toBe(0.3);
    expect(moneyAdd('0.1', '0.2')).toBe('0.300000000000000000');
    expect(moneySubtract('0.3', '0.1')).toBe('0.200000000000000000');
    expect(moneyAdd('0.000000000000000001', '0.000000000000000002')).toBe('0.000000000000000003');
    expect(moneySubtract('1', '1.5')).toBe('-0.500000000000000000');
    expect(moneySubtract('5', '5')).toBe('0.000000000000000000');
  });

  it('compares amounts of different scale as equal when numerically equal', () => {
    expect(moneyEquals('10', '10.000')).toBe(true);
    expect(moneyCompare('10', '10.00')).toBe(0);
    expect(moneyCompare('0.1', '0.10000000000000000')).toBe(0);
    expect(moneyEquals('0.000000000000000001', '0')).toBe(false);
    expect(moneyCompare('9007199254740993', '9007199254740992')).toBe(1);
  });

  it('rejects negative, non-numeric and exponent-notation amounts', () => {
    for (const bad of ['-1', '-0.5', 'abc', 'NaN', '', '1e3', '1E-7', '1,5', ' 1', '1.', '.5']) {
      expect(MoneyAmountSchema.safeParse(bad).success, bad).toBe(false);
      expect(isPositiveMoney(bad), bad).toBe(false);
    }
    expect(isPositiveMoney('0')).toBe(false);
    expect(isPositiveMoney('0.000')).toBe(false);
    expect(isPositiveMoney('0.000000000000000001')).toBe(true);
  });

  it('keeps the ledger scale and never rounds an amount with extra decimals', () => {
    expect(MoneyAmountSchema.safeParse('1.123456789012345678').success).toBe(true);
    expect(MoneyAmountSchema.safeParse('1.1234567890123456789').success).toBe(false);
    expect(moneyFloorToScale('1.999999', 2)).toBe('1.99');
    expect(moneyFloorToScale('0.009999999999999999', 2)).toBe('0.00');
  });
});

describe('reference value conversion', () => {
  it('multiplies the amount by the stored rate without float error and truncates at the ledger scale', () => {
    expect(moneyScaleBy('3', '0.1')).toBe('0.300000000000000000');
    expect(moneyScaleBy('100', '0.00002345')).toBe('0.002345000000000000');
    expect(moneyScaleBy('0.000000000000000001', '0.5')).toBe('0.000000000000000000');
    expect(moneyScaleBy('7', '1')).toBe('7.000000000000000000');
  });

  it.todo('keeps the rate and timestamp on the reference snapshot of the ledger row');

  it('falls back to the configured default reference currency, upper-cased, when none is set', () => {
    expect(resolveWalletReferenceCurrency(undefined)).toBe('USD');
    expect(resolveWalletReferenceCurrency({ defaultReferenceCurrency: 'eur' })).toBe('EUR');
  });

  it.todo(
    'chooses the deposit-limit currency, else the wager-limit currency, else the default as the reference currency',
  );
});
