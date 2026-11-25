import { describe, it } from 'vitest';

describe('isWalletAddressValidForNetwork', () => {
  it.todo('accepts a valid P2PKH, P2SH and bech32 address for BTC');
  it.todo('accepts a short P2WPKH BTC address');
  it.todo('rejects a bech32 address with a bad checksum');
  it.todo('rejects a BTC address with a wrong prefix or illegal characters');
  it.todo('accepts a valid EVM address and rejects a wrong length or non-hex one');
  it.todo('accepts a valid XRP ledger address and rejects one outside the length bound');
  it.todo('looks the network up case-insensitively');
  it.todo('accepts any address of 8 to 128 characters for a network with no pattern');
  it.todo(
    'rejects an address shorter than 8 or longer than 128 characters for a network with no pattern',
  );
});

describe('withdrawal minimum', () => {
  it.todo('refuses an amount below the asset minimum');
  it.todo('accepts an amount equal to the asset minimum');
  it.todo('passes a currency-level request when the currency has no catalog row');
  it.todo('refuses a request naming a network that has no catalog row');
  it.todo('uses the row of the named network when several networks exist');
});

describe('withdrawal fee', () => {
  it.todo('returns the fee of the named network row');
  it.todo('returns zero when the asset has no fee');
  it.todo('refuses an amount equal to or below the fee');
  it.todo('computes the net payout as amount minus fee without float rounding');
});

describe('payable precision', () => {
  it.todo('accepts an amount with at most the asset decimals');
  it.todo('refuses an amount with more decimals than the asset allows and never rounds it');
  it.todo('treats trailing zeros beyond the allowed decimals as valid');
});

describe('deposit minimum', () => {
  it.todo('refuses a zero amount whatever the floor');
  it.todo('refuses an amount below the minimum of the event network row');
  it.todo('uses the row of the one network the address was issued on when the event names none');
  it.todo('uses the lowest row when the address has no row or several for that currency');
  it.todo('counts a row with deposits switched off as the floor');
  it.todo('accepts an amount equal to the minimum');
});

describe('decimal money math', () => {
  it.todo('adds and subtracts amounts without binary float error');
  it.todo('compares amounts of different scale as equal when numerically equal');
  it.todo('rejects negative, non-numeric and exponent-notation amounts');
  it.todo('keeps the ledger scale and never rounds an amount with extra decimals');
});

describe('reference value conversion', () => {
  it.todo('multiplies the amount by the stored rate and keeps the rate and timestamp');
  it.todo(
    'chooses the deposit-limit currency, else the wager-limit currency, else the default as the reference currency',
  );
});
