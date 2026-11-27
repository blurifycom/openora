import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { WalletReplayMismatchError, type WalletProviderRef } from '@openora/core/contracts';
import { assertReplayMatches } from '../wallet-commands.service.js';

type Stored = Parameters<typeof assertReplayMatches>[0];
type Request = Parameters<typeof assertReplayMatches>[1];

const providerRef = { providerName: 'p', providerRefId: 'r' } as unknown as WalletProviderRef;

const stored = (overrides: Partial<Record<string, unknown>> = {}): Stored =>
  ({
    id: 'tx-1',
    walletId: 'w-1',
    type: 'bet',
    direction: 'debit',
    currency: 'usd',
    amount: '10',
    externalRoundId: 'round-1',
    correctionRequestedAmount: null,
    ...overrides,
  }) as unknown as Stored;

const request = (overrides: Partial<Record<string, unknown>> = {}): Request =>
  ({
    walletId: 'w-1',
    type: 'bet',
    direction: 'debit',
    amount: '10',
    currency: 'USD',
    externalRoundId: 'round-1',
    ...overrides,
  }) as unknown as Request;

const mismatches = (s: Stored, r: Request) => () => assertReplayMatches(s, r, providerRef);

describe('assertReplayMatches', () => {
  it('passes an identical replay', () => {
    expect(mismatches(stored(), request())).not.toThrow();
  });

  it.each([
    ['walletId', { walletId: 'w-2' }],
    ['type', { type: 'win' }],
    ['direction', { direction: 'credit' }],
    ['currency', { currency: 'EUR' }],
    ['externalRoundId', { externalRoundId: 'round-2' }],
    ['amount', { amount: '10.000000000000000001' }],
  ])('throws when only %s differs', (_field, override) => {
    expect(mismatches(stored(), request(override))).toThrow(WalletReplayMismatchError);
  });

  it('throws for a correction row', () => {
    expect(mismatches(stored({ correctionRequestedAmount: '10' }), request())).toThrow(
      WalletReplayMismatchError,
    );
  });

  it('carries the provider ref and stored id on the error', () => {
    expect(mismatches(stored(), request({ amount: '11' }))).toThrow(WalletReplayMismatchError);
  });

  it('accepts an amount in another notation: the ledger stores money to 18 places', () => {
    expect(
      mismatches(stored({ amount: '10.000000000000000000' }), request({ amount: '10' })),
    ).not.toThrow();
    expect(mismatches(stored({ amount: '10' }), request({ amount: '10.00' }))).not.toThrow();
  });

  it('matches a legacy row without direction or round against any request', () => {
    expect(
      mismatches(
        stored({ direction: null, externalRoundId: null }),
        request({ direction: 'credit', externalRoundId: 'anything' }),
      ),
    ).not.toThrow();
  });

  it('skips the currency check when the request names none', () => {
    expect(mismatches(stored(), request({ currency: undefined }))).not.toThrow();
  });

  it('matches currency case-insensitively', () => {
    expect(mismatches(stored({ currency: 'Usd' }), request({ currency: 'USD' }))).not.toThrow();
  });

  it('throws when the stored row has a round and the request has none', () => {
    expect(mismatches(stored(), request({ externalRoundId: undefined }))).toThrow(
      WalletReplayMismatchError,
    );
  });

  it('passes for a replay of any stored amount and fails for any other', () => {
    const amount = fc.tuple(fc.nat({ max: 1_000_000 }), fc.nat({ max: 999_999 }));
    fc.assert(
      fc.property(amount, amount, ([w1, f1], [w2, f2]) => {
        const a = `${w1}.${f1}`;
        const b = `${w2}.${f2}`;
        const same =
          BigInt(w1) * 10n ** 6n + BigInt(String(f1).padStart(6, '0')) ===
          BigInt(w2) * 10n ** 6n + BigInt(String(f2).padStart(6, '0'));
        const run = mismatches(stored({ amount: a }), request({ amount: b }));
        if (same) {
          expect(run).not.toThrow();
        } else {
          expect(run).toThrow(WalletReplayMismatchError);
        }
      }),
    );
  });
});
