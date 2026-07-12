import { describe, it, expect } from 'vitest';
import type { WalletTransactionType } from '@openora/core/contracts';
import { WalletCommandsService } from '../service/wallet-commands.service.js';

type Row = Record<string, unknown>;

// Chainable Drizzle double: `select` returns the seeded wallet, the guarded `update` reports the
// new balance (as Postgres numeric arithmetic would) via `returning`, and every `insert().values()`
// is captured for assertion.
function makeTxn({ walletRow, updateReturns }: { walletRow?: Row; updateReturns?: Row[] }) {
  const inserts: Row[] = [];
  const calls = { update: 0 };
  const txn = {
    select: () => ({
      from: () => ({ where: () => Promise.resolve(walletRow ? [walletRow] : []) }),
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            calls.update++;
            return updateReturns ?? [{ balance: '0' }];
          },
        }),
      }),
    }),
    insert: () => ({
      values: (v: Row) => {
        inserts.push(v);
        return Promise.resolve([]);
      },
    }),
  };
  return { txn, inserts, calls };
}

const svc = new WalletCommandsService();
const usdWallet = { id: 'w1', userId: 'u1', balance: '100', currency: 'USD' };

describe('WalletCommandsService.debit', () => {
  it('debits the balance and writes a completed bet ledger row', async () => {
    const { txn, inserts, calls } = makeTxn({
      walletRow: usdWallet,
      updateReturns: [{ balance: '90' }],
    });

    const res = await svc.debit(txn, { userId: 'u1', amount: '10', type: 'bet' });

    expect(res).toEqual({ ok: true, newBalance: '90' });
    expect(calls.update).toBe(1);
    expect(inserts[0]).toMatchObject({
      walletId: 'w1',
      type: 'bet',
      amount: '10',
      currency: 'USD',
      status: 'completed',
      rail: 'fiat',
    });
  });

  it('loss writes a 0-amount informational row and never touches the balance', async () => {
    const { txn, inserts, calls } = makeTxn({ walletRow: usdWallet });

    const res = await svc.debit(txn, { userId: 'u1', amount: '0', type: 'loss' });

    expect(res).toEqual({ ok: true, newBalance: '100' });
    expect(calls.update).toBe(0);
    expect(inserts[0]).toMatchObject({ type: 'loss', amount: '0', status: 'completed' });
  });

  it('rejects a non-positive amount for a real-money debit', async () => {
    const { txn, inserts } = makeTxn({ walletRow: usdWallet });

    await expect(svc.debit(txn, { userId: 'u1', amount: '0', type: 'bet' })).rejects.toThrow(
      /positive/,
    );
    expect(inserts).toHaveLength(0);
  });

  it('fails with the shortfall and writes no ledger row when the guard debits zero rows', async () => {
    const { txn, inserts } = makeTxn({
      walletRow: { ...usdWallet, balance: '5' },
      updateReturns: [],
    });

    const res = await svc.debit(txn, { userId: 'u1', amount: '10', type: 'bet' });

    expect(res).toEqual({ ok: false, available: '5' });
    expect(inserts).toHaveLength(0);
  });
});

describe('WalletCommandsService.credit', () => {
  it('increases the balance and writes a completed win ledger row', async () => {
    const { txn, inserts } = makeTxn({
      walletRow: { ...usdWallet, balance: '50' },
      updateReturns: [{ balance: '70' }],
    });

    const res = await svc.credit(txn, { userId: 'u1', amount: '20', type: 'win' });

    expect(res).toEqual({ ok: true, newBalance: '70' });
    expect(inserts[0]).toMatchObject({
      walletId: 'w1',
      type: 'win',
      amount: '20',
      status: 'completed',
      rail: 'fiat',
    });
  });

  it('returns the exact decimal-string newBalance from the DB (no float drift)', async () => {
    const { txn } = makeTxn({
      walletRow: { ...usdWallet, balance: '50' },
      updateReturns: [{ balance: '70' }],
    });

    const res = await svc.credit(txn, {
      userId: 'u1',
      amount: '20',
      type: 'win',
    });

    expect(res).toEqual({ ok: true, newBalance: '70' });
  });

  it('fails closed on a missing wallet rather than creating one', async () => {
    const { txn, inserts } = makeTxn({});

    const res = await svc.credit(txn, { userId: 'u1', amount: '20', type: 'win' });

    expect(res).toEqual({ ok: false, reason: 'wallet not found' });
    expect(inserts).toHaveLength(0);
  });

  it('rejects a non-positive credit', async () => {
    const { txn } = makeTxn({ walletRow: usdWallet });

    await expect(svc.credit(txn, { userId: 'u1', amount: '0', type: 'win' })).rejects.toThrow(
      /positive/,
    );
  });
});

// Balance must equal Σ credits − Σ debits − Σ held withdrawals, checked against a stateful
// double through a deposit → bet → hold → settle(win) sequence. The mock queues the post-mutation
// balance per call (the real DB does this arithmetic in numeric SQL, never JS).
describe('wallet ledger reconciliation', () => {
  it('balance equals credits − debits − held withdrawals after deposit/bet/settle', async () => {
    const rows: Row[] = [];
    const updateResults: Row[] = [
      { balance: '100' }, // deposit credit: 0 + 100
      { balance: '70' }, // bet debit: 100 - 30
      { balance: '110' }, // win credit: 50 (after the -20 hold below) + 60
    ];
    let updateIdx = 0;
    const txn = {
      select: () => ({
        from: () => ({
          where: () => Promise.resolve([{ id: 'w1', userId: 'u1', currency: 'USD' }]),
        }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: async () => [updateResults[updateIdx++]] }) }),
      }),
      insert: () => ({
        values: (v: Row) => {
          rows.push(v);
          return Promise.resolve([]);
        },
      }),
    };

    const deposit = await svc.credit(txn, { userId: 'u1', amount: '100', type: 'deposit' });
    let balance = Number((deposit as { newBalance: string }).newBalance);

    const bet = await svc.debit(txn, { userId: 'u1', amount: '30', type: 'bet' });
    balance = Number((bet as { newBalance: string }).newBalance);

    // A pending withdrawal hold: balance debited at request time, row stays pending. Exercises the held term.
    rows.push({ type: 'withdrawal', status: 'pending', amount: '20' });
    balance -= 20;

    const win = await svc.credit(txn, { userId: 'u1', amount: '60', type: 'win' });
    balance = Number((win as { newBalance: string }).newBalance);

    const isCredit = (t: WalletTransactionType) =>
      t === 'deposit' || t === 'win' || t === 'bonus' || t === 'tip';
    const num = (v: unknown) => Number(v);

    let credits = 0;
    let debits = 0;
    let held = 0;
    for (const r of rows) {
      const type = r['type'] as WalletTransactionType | 'withdrawal';
      const amount = num(r['amount']);
      if (type === 'withdrawal') {
        if (r['status'] === 'pending' || r['status'] === 'processing') {
          held += amount;
        }
      } else if (isCredit(type)) {
        if (r['status'] === 'completed') {
          credits += amount;
        }
      } else {
        debits += amount;
      }
    }

    expect(credits - debits - held).toBe(balance);
    expect(balance).toBe(110);
  });
});
