import fc from 'fast-check';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { DrizzleService } from '@openora/core/server';
import { DEFAULT_PAYMENT_PROVIDER } from '@openora/core/contracts';
import {
  SWAP_DESK_PROVIDER_LABEL,
  checkLedgerPage,
  ledgerBreachKey,
  ledgerPairKey,
  ledgerUncheckedKey,
  backfillMismatchKey,
  ledgerUncheckedDetail,
  parseBalanceAtFiling,
  parseLedgerBreachKey,
  parseLedgerPairKey,
  parseLedgerUncheckedKey,
} from '../ledger-invariant.service.js';

const currency = fc.stringMatching(/^[A-Z0-9_]{1,12}$/);
const baselineId = fc.option(fc.uuid(), { nil: null });
const drift = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 10n ** 18n }),
    fc.option(fc.stringMatching(/^[0-9]{1,18}$/), { nil: null }),
  )
  .map(([neg, whole, frac]) => `${neg ? '-' : ''}${whole}${frac === null ? '' : `.${frac}`}`);

describe('ledger finding keys', () => {
  it('property: pair key round-trips', () => {
    fc.assert(
      fc.property(fc.uuid(), currency, (walletId, cur) => {
        expect(parseLedgerPairKey(ledgerPairKey(walletId, cur))).toEqual({
          walletId,
          currency: cur,
        });
      }),
    );
  });

  it('property: every key kind starts with the pair key and parses back to the same pair', () => {
    fc.assert(
      fc.property(fc.uuid(), currency, baselineId, drift, (walletId, cur, base, d) => {
        const keys = [
          ledgerBreachKey(walletId, cur, base, d),
          ledgerUncheckedKey(walletId, cur, base),
          backfillMismatchKey(walletId, cur, d),
        ];
        for (const key of keys) {
          expect(key.startsWith(ledgerPairKey(walletId, cur))).toBe(true);
          expect(parseLedgerPairKey(key)).toEqual({ walletId, currency: cur });
        }
      }),
    );
  });

  it('property: breach key round-trips baseline and drift', () => {
    fc.assert(
      fc.property(fc.uuid(), currency, baselineId, drift, (walletId, cur, base, d) => {
        expect(parseLedgerBreachKey(ledgerBreachKey(walletId, cur, base, d))).toEqual({
          baselineId: base,
          drift: d,
        });
      }),
    );
  });

  it('property: unchecked key round-trips baseline', () => {
    fc.assert(
      fc.property(fc.uuid(), currency, baselineId, (walletId, cur, base) => {
        expect(parseLedgerUncheckedKey(ledgerUncheckedKey(walletId, cur, base))).toEqual({
          baselineId: base,
        });
      }),
    );
  });

  it('property: backfill mismatch key round-trips drift through the unchecked parser', () => {
    fc.assert(
      fc.property(fc.uuid(), currency, drift, (walletId, cur, d) => {
        expect(parseLedgerUncheckedKey(backfillMismatchKey(walletId, cur, d))).toEqual({
          backfillDrift: d,
        });
      }),
    );
  });

  it('property: a breach key is never read as an unchecked key and vice versa', () => {
    fc.assert(
      fc.property(fc.uuid(), currency, baselineId, drift, (walletId, cur, base, d) => {
        expect(parseLedgerUncheckedKey(ledgerBreachKey(walletId, cur, base, d))).toBeNull();
        expect(parseLedgerBreachKey(ledgerUncheckedKey(walletId, cur, base))).toBeNull();
        expect(parseLedgerBreachKey(backfillMismatchKey(walletId, cur, d))).toBeNull();
      }),
    );
  });

  it('keeps the none sentinel distinct from a baseline id', () => {
    const wallet = '11111111-1111-4111-8111-111111111111';
    expect(ledgerUncheckedKey(wallet, 'BTC', null)).toBe(`wallet:${wallet}:BTC:none`);
    expect(ledgerBreachKey(wallet, 'BTC', null, '-1.5')).toBe(`wallet:${wallet}:BTC:none:-1.5`);
  });

  it('returns null for null and garbage input', () => {
    const garbage = [
      '',
      'wallet',
      'wallet:',
      'wallet:not-a-uuid:BTC',
      'wallet:11111111-1111-4111-8111-111111111111:',
      'deposit:11111111-1111-4111-8111-111111111111:BTC',
      ' wallet:11111111-1111-4111-8111-111111111111:BTC',
    ];
    expect(parseLedgerPairKey(null)).toBeNull();
    expect(parseLedgerBreachKey(null)).toBeNull();
    expect(parseLedgerUncheckedKey(null)).toBeNull();
    for (const input of garbage) {
      expect(parseLedgerPairKey(input)).toBeNull();
      expect(parseLedgerBreachKey(input)).toBeNull();
      expect(parseLedgerUncheckedKey(input)).toBeNull();
    }
  });

  it('rejects malformed drift and baseline segments', () => {
    const wallet = '11111111-1111-4111-8111-111111111111';
    const baseline = '22222222-2222-4222-8222-222222222222';
    for (const bad of ['', 'abc', '1.', '.5', '+1', '1e5', '1,5', '--1']) {
      expect(parseLedgerBreachKey(`wallet:${wallet}:BTC:${baseline}:${bad}`)).toBeNull();
    }
    expect(parseLedgerBreachKey(`wallet:${wallet}:BTC:nope:1`)).toBeNull();
    expect(parseLedgerUncheckedKey(`wallet:${wallet}:BTC:nope`)).toBeNull();
    expect(parseLedgerUncheckedKey(`wallet:${wallet}:BTC:${baseline}:extra`)).toBeNull();
  });

  it('property: arbitrary strings never throw', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        parseLedgerPairKey(s);
        parseLedgerBreachKey(s);
        parseLedgerUncheckedKey(s);
        parseBalanceAtFiling(s);
      }),
    );
  });
});

describe('parseBalanceAtFiling', () => {
  const pair = { walletId: 'w', currency: 'BTC', unpricedRows: 3 };

  it('property: reads back the balance the detail was built with', () => {
    fc.assert(
      fc.property(drift, (balance) => {
        expect(parseBalanceAtFiling(ledgerUncheckedDetail({ ...pair, balance }))).toBe(balance);
      }),
    );
  });

  it('returns null for null, a detail without the marker, and a marker that is not the suffix', () => {
    expect(parseBalanceAtFiling(null)).toBeNull();
    expect(parseBalanceAtFiling('')).toBeNull();
    expect(parseBalanceAtFiling('wallet w holds 3 BTC ledger rows')).toBeNull();
    expect(parseBalanceAtFiling('(balance at filing: 5) trailing')).toBeNull();
    expect(parseBalanceAtFiling('(balance at filing: abc)')).toBeNull();
    expect(parseBalanceAtFiling('(balance at filing: )')).toBeNull();
  });
});

describe('checkLedgerPage settled-by-hand rows', () => {
  const drizzle = new DrizzleService('postgres://unit:[redacted]@127.0.0.1:1/unit');
  afterAll(() => drizzle.dispose());

  const renderedCheck = async () => {
    const execute = vi.spyOn(drizzle.db, 'execute').mockResolvedValue({
      rows: [],
      command: 'SELECT',
      rowCount: 0,
      oid: 0,
      fields: [],
    });
    await checkLedgerPage(drizzle.db, null, 10, '00000000-0000-4000-8000-000000000001', {
      graceSeconds: 0,
      cutBefore: '2026-01-01 00:00:00+00',
    });
    const query = execute.mock.calls[0]?.[0];
    execute.mockRestore();
    if (!query || !(query instanceof SQL)) {
      throw new Error('checkLedgerPage ran no SQL query');
    }
    return new PgDialect().sqlToQuery(query);
  };

  const branch = (text: string, from: string, to: string) =>
    text.slice(text.indexOf(from), text.indexOf(to, text.indexOf(from)));

  it.each([
    [
      'a withdrawal',
      "when t.type = 'withdrawal'",
      "when t.type = 'swap_out'",
      'unknown_at_provider',
      DEFAULT_PAYMENT_PROVIDER,
    ],
    ['a swap leg', "when t.type = 'swap_out'", 'else', 'stuck_swap', SWAP_DESK_PROVIDER_LABEL],
  ])('lets a manual credit settle %s failed by hand', async (_name, from, to, kind, provider) => {
    const { sql: text, params } = await renderedCheck();
    const clause = branch(text, from, to);
    const placeholders = [...clause.matchAll(/\$(\d+)/g)].map((m) => params[Number(m[1]) - 1]);
    expect(clause).toContain("m.type = 'manual_credit'");
    expect(clause).toContain('f.external_id in (t.provider_ref_id, t.id::text)');
    expect(placeholders).toContain(kind);
    expect(placeholders).toContain(provider);
  });
});
