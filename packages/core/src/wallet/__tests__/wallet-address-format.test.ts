import { describe, it, expect } from 'vitest';
import {
  isWalletAddressValidForNetwork,
  CreateWithdrawalAddressInputSchema,
  WithdrawInputSchema,
} from '../contract/index.js';

const VALID_BY_NETWORK: Record<string, string> = {
  SEGWIT: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  BITCOIN_CASH: 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a',
  LITECOIN: 'ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9',
  DOGECOIN: 'DBXu2kgc3xtvCUWFcxFE3r9hEYgmuaaCyD',
  XRP_LEDGER: 'rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh',
  ERC20: '0x1111111111111111111111111111111111111111',
  BEP20: '0x1111111111111111111111111111111111111111',
  TRC20: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
  SOLANA: '5FHwkrdxSFrHm2h8hZvfF3TN3zCz6E5uH3xYFecKC2Sy',
};

const INVALID_BY_NETWORK: Record<string, string> = {
  SEGWIT: 'not-a-valid-address',
  BITCOIN_CASH: 'not-a-valid-address',
  LITECOIN: 'not-a-valid-address',
  DOGECOIN: 'not-a-valid-address',
  XRP_LEDGER: 'not-a-valid-address',
  ERC20: 'not-a-valid-address-zzzz',
  BEP20: 'not-a-valid-address-zzzz',
  TRC20: 'not-a-valid-address',
  SOLANA: 'not!!avalid00000',
};

describe('isWalletAddressValidForNetwork', () => {
  for (const [network, address] of Object.entries(VALID_BY_NETWORK)) {
    it(`accepts a well-formed ${network} address`, () => {
      expect(isWalletAddressValidForNetwork(address, network)).toBe(true);
    });
  }

  for (const [network, address] of Object.entries(INVALID_BY_NETWORK)) {
    it(`rejects a malformed ${network} address`, () => {
      expect(isWalletAddressValidForNetwork(address, network)).toBe(false);
    });
  }

  it('looks the pattern up case-insensitively by network', () => {
    expect(isWalletAddressValidForNetwork(VALID_BY_NETWORK['ERC20']!, 'erc20')).toBe(true);
  });

  it('accepts any well-formed string for a network with no entry in the table - an operator can add a chain core has never heard of', () => {
    expect(isWalletAddressValidForNetwork('some-brand-new-chain-address', 'RIPPLENET')).toBe(true);
    expect(isWalletAddressValidForNetwork('short', 'RIPPLENET')).toBe(false);
  });

  it('rejects a bech32 address whose checksum does not match, the shape pattern alone cannot', () => {
    expect(
      isWalletAddressValidForNetwork('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'SEGWIT'),
    ).toBe(false);
    expect(
      isWalletAddressValidForNetwork('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'SEGWIT'),
    ).toBe(false);
    expect(
      isWalletAddressValidForNetwork('ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7k7grplx', 'LITECOIN'),
    ).toBe(false);
  });

  it.each([
    ['bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq', 'P2WPKH mainnet'],
    ['tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'P2WPKH testnet'],
    ['tb1qqltm70wyz734t9k8d9w70uuhyxnemyh56d5ra8rtw082ytd7ywmsqudq5e', 'P2WSH testnet'],
    ['bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080', 'P2WPKH regtest'],
    ['tltc1qw508d6qejxtdg4y5r3zarvary0c5xw7klfsuq0', 'P2WPKH litecoin testnet'],
  ])('accepts %s (%s)', (address) => {
    const network = address.startsWith('ltc') || address.startsWith('tltc') ? 'LITECOIN' : 'SEGWIT';
    expect(isWalletAddressValidForNetwork(address, network)).toBe(true);
  });

  it('accepts a taproot address, which is bech32m rather than bech32', () => {
    expect(
      isWalletAddressValidForNetwork(
        'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
        'SEGWIT',
      ),
    ).toBe(true);
  });

  it('rejects a version 0 address whose witness program is neither 20 nor 32 bytes', () => {
    expect(isWalletAddressValidForNetwork('bc1qw508d6qejxtdg4y5r3zarvary0ur4le6', 'SEGWIT')).toBe(
      false,
    );
  });

  it('leaves a base58 address on a bech32 chain to the pattern - it carries no bech32 checksum', () => {
    expect(isWalletAddressValidForNetwork('1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2', 'SEGWIT')).toBe(
      true,
    );
  });

  it('does not trim or change case - callers own that', () => {
    const padded = `  ${VALID_BY_NETWORK['ERC20']}  `;
    expect(isWalletAddressValidForNetwork(padded, 'ERC20')).toBe(false);
    const lower = VALID_BY_NETWORK['TRC20']!.toLowerCase();
    expect(isWalletAddressValidForNetwork(lower, 'TRC20')).toBe(false);
  });
});

describe('CreateWithdrawalAddressInputSchema network/address cross-check', () => {
  it('rejects a mismatched network/address pair on the address field', () => {
    const result = CreateWithdrawalAddressInputSchema.safeParse({
      label: 'Ledger',
      currency: 'BTC',
      network: 'SEGWIT',
      address: INVALID_BY_NETWORK['SEGWIT'],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['address']);
  });

  it('trims before checking the format, so a pasted address with stray whitespace still validates', () => {
    const result = CreateWithdrawalAddressInputSchema.safeParse({
      label: 'Ledger',
      currency: 'USDT',
      network: 'ERC20',
      address: `  ${VALID_BY_NETWORK['ERC20']}  `,
    });
    expect(result.success).toBe(true);
  });
});

describe('WithdrawInputSchema network/destinationAddress cross-check', () => {
  it('rejects a mismatched network/address pair on the destinationAddress field', () => {
    const result = WithdrawInputSchema.safeParse({
      amount: '10',
      currency: 'BTC',
      network: 'SEGWIT',
      idempotencyKey: '9a2f7c11-0000-4000-8000-00000000a001',
      destinationAddress: INVALID_BY_NETWORK['SEGWIT'],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['destinationAddress']);
  });

  it('skips the check when network is absent - a single-chain currency has none to check against', () => {
    const result = WithdrawInputSchema.safeParse({
      amount: '10',
      currency: 'BTC',
      idempotencyKey: '9a2f7c11-0000-4000-8000-00000000a001',
      destinationAddress: 'anything-well-formed-enough',
    });
    expect(result.success).toBe(true);
  });

  it('skips the check when destinationAddress is absent', () => {
    const result = WithdrawInputSchema.safeParse({
      amount: '10',
      currency: 'BTC',
      network: 'SEGWIT',
      idempotencyKey: '9a2f7c11-0000-4000-8000-00000000a001',
    });
    expect(result.success).toBe(true);
  });
});
