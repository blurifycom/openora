import { describe, it, expect } from 'vitest';
import { WALLET_TRANSACTION_TYPES, type WalletTransactionType } from '@openora/core/contracts';

// Mirrors the CASE mapping hand-appended to
// drizzle/migrations/0014_abandoned_madripoor.sql. Kept in lockstep here so a future type
// added to WALLET_TRANSACTION_TYPES fails this test instead of silently backfilling as
// NULL (or, worse, someone guessing a direction for it).
const BACKFILL_CREDIT_TYPES: WalletTransactionType[] = ['deposit', 'win', 'bonus', 'manual_credit'];
const BACKFILL_DEBIT_TYPES: WalletTransactionType[] = ['withdrawal', 'bet', 'loss', 'manual_debit'];

// The only types where the same value is written for both legs of a transfer (see
// engagement/social-transfers/service/social-transfers.service.ts), so a historical row
// has no recoverable direction and the migration deliberately leaves it NULL.
const KNOWN_AMBIGUOUS_TYPES: WalletTransactionType[] = ['gift', 'rain', 'tip'];

describe('wallet_transaction direction backfill vocabulary', () => {
  it('accounts for every WALLET_TRANSACTION_TYPES value exactly once', () => {
    const partitioned = [
      ...BACKFILL_CREDIT_TYPES,
      ...BACKFILL_DEBIT_TYPES,
      ...KNOWN_AMBIGUOUS_TYPES,
    ];

    expect(new Set(partitioned).size).toBe(partitioned.length);
    expect([...partitioned].sort()).toEqual([...WALLET_TRANSACTION_TYPES].sort());
  });
});
