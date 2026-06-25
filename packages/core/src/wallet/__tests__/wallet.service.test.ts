import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  WalletService,
  WalletNotFoundError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  InsufficientBalanceError,
  CurrencyMismatchError,
} from '../service/wallet.service.js';

type Row = Record<string, unknown>;

// A chainable, awaitable Drizzle query double. Chain methods (incl. `.for('update')`)
// return the builder; awaiting the builder pops the next `select` queue entry; `.returning`
// pops the `returning` queue. Each terminal read pops one queue entry in call order, so a
// test supplies the per-statement results in the order the service issues them.
function makeQueryBuilder(results: { select: Row[][]; returning: Row[][] }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder['select'] = vi.fn(chain);
  builder['from'] = vi.fn(chain);
  builder['innerJoin'] = vi.fn(chain);
  builder['leftJoin'] = vi.fn(chain);
  builder['orderBy'] = vi.fn(chain);
  builder['limit'] = vi.fn(chain);
  builder['offset'] = vi.fn(chain);
  builder['for'] = vi.fn(chain);
  builder['insert'] = vi.fn(chain);
  builder['values'] = vi.fn(chain);
  builder['update'] = vi.fn(chain);
  builder['set'] = vi.fn(chain);
  builder['delete'] = vi.fn(chain);
  builder['where'] = vi.fn(chain);
  builder['returning'] = vi.fn(() => Promise.resolve(results.returning.shift() ?? []));
  // oxlint-disable-next-line unicorn/no-thenable -- the builder must be awaitable to mimic Drizzle.
  builder['then'] = (resolve: (v: Row[]) => unknown) => resolve(results.select.shift() ?? []);
  return builder;
}

function makeDrizzle(results: { select?: Row[][]; returning?: Row[][] } = {}) {
  const state = { select: results.select ?? [], returning: results.returning ?? [] };
  const builder = makeQueryBuilder(state);
  const db = {
    ...builder,
    transaction: vi.fn(async (fn: (txn: unknown) => Promise<unknown>) => fn(builder)),
  };
  return { db } as unknown as import('@blurifycom/core/server').DrizzleService;
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn(), emitInTransaction: vi.fn() };
}

function makePayment() {
  return {
    processDeposit: vi.fn().mockResolvedValue({ externalId: 'ext-1', status: 'completed' }),
    processWithdrawal: vi.fn().mockResolvedValue({ externalId: 'ext-2', status: 'completed' }),
  };
}

function makeDirectory(summaries: Row[] = []) {
  return {
    count: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    lookupPlayers: vi.fn().mockResolvedValue(summaries),
  };
}

// oxlint-disable typescript/no-explicit-any
const svcOf = (drizzle: unknown, events: unknown, payment: unknown, directory?: unknown) =>
  new WalletService(drizzle as any, events as any, payment as any, directory as any);

describe('WalletService domain errors', () => {
  it('WalletNotFoundError carries the userId', () => {
    const err = new WalletNotFoundError('user-123');
    expect(err.name).toBe('WalletNotFoundError');
    expect(err.message).toContain('user-123');
  });

  it('InsufficientBalanceError carries available and requested amounts', () => {
    const err = new InsufficientBalanceError(50, 100);
    expect(err.message).toContain('50');
    expect(err.message).toContain('100');
  });
});

describe('WalletService.withdraw', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('locks the wallet row, holds funds, creates a pending withdrawal, and emits requested', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }]],
      returning: [
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
        [{ id: 'w-1' }], // guarded debit affected exactly one row
      ],
    });
    const forSpy = (drizzle.db as unknown as { for: ReturnType<typeof vi.fn> }).for;
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.withdraw('u-1', 40, 'USD');

    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
    expect(forSpy).toHaveBeenCalledWith('update');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('wallet.withdrawal.requested', {
      userId: 'u-1',
      amount: 40,
      currency: 'USD',
      transactionId: 'tx-1',
    });
  });

  it('derives the fireblocks rail for crypto currencies', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '5', currency: 'BTC' }]],
      returning: [
        [{ id: 'tx-2', walletId: 'w-1', amount: '1', currency: 'BTC', status: 'pending' }],
        [{ id: 'w-1' }],
      ],
    });
    const valuesSpy = (drizzle.db as unknown as { values: ReturnType<typeof vi.fn> }).values;
    const svc = svcOf(drizzle, events, payment);

    await svc.withdraw('u-1', 1, 'BTC');

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ rail: 'fireblocks' }));
  });

  it('throws CurrencyMismatchError when the request currency differs from the wallet', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }]],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(svc.withdraw('u-1', 40, 'EUR')).rejects.toBeInstanceOf(CurrencyMismatchError);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('rejects when the guarded debit affects zero rows (insufficient balance)', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '10', currency: 'USD' }]],
      returning: [
        [{ id: 'tx-x', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
        [], // guarded UPDATE ... WHERE balance >= amount matched no row
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(svc.withdraw('u-1', 40, 'USD')).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('WalletService.approveWithdrawal', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('moves pending -> processing -> completed, calls the PSP, and emits approved then completed', async () => {
    const drizzle = makeDrizzle({
      select: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'pending',
            amount: '40',
            currency: 'USD',
          },
        ],
        [{ userId: 'u-1' }], // userIdForWallet
        [], // final "completed" update (awaited, unused)
      ],
      returning: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'processing',
            amount: '40',
            currency: 'USD',
            rail: 'psp',
          },
        ],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.approveWithdrawal('admin-1', 'tx-1');

    expect(result).toEqual({ transactionId: 'tx-1', status: 'completed' });
    expect(payment.processWithdrawal).toHaveBeenCalledWith(40, 'USD', {
      transactionId: 'tx-1',
      userId: 'u-1',
      rail: 'psp',
      adminId: 'admin-1',
    });
    expect(events.emit).toHaveBeenNthCalledWith(1, 'wallet.withdrawal.approved', {
      userId: 'u-1',
      amount: 40,
      currency: 'USD',
      transactionId: 'tx-1',
      adminId: 'admin-1',
    });
    expect(events.emit).toHaveBeenNthCalledWith(2, 'wallet.withdrawal.completed', {
      userId: 'u-1',
      amount: 40,
      currency: 'USD',
      transactionId: 'tx-1',
    });
  });

  it('on PSP failure marks failed, refunds, emits failed, and rethrows', async () => {
    const drizzle = makeDrizzle({
      select: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'pending',
            amount: '40',
            currency: 'USD',
          },
        ],
        [{ userId: 'u-1' }], // userIdForWallet
        [], // failed-status update (awaited, unused)
        [], // refund balance update (awaited, unused)
      ],
      returning: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'processing',
            amount: '40',
            currency: 'USD',
          },
        ],
      ],
    });
    payment.processWithdrawal.mockRejectedValueOnce(new Error('psp down'));
    const setSpy = (drizzle.db as unknown as { set: ReturnType<typeof vi.fn> }).set;
    const svc = svcOf(drizzle, events, payment);

    await expect(svc.approveWithdrawal('admin-1', 'tx-1')).rejects.toThrow('psp down');

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ balance: expect.anything() }));
    expect(events.emit).toHaveBeenCalledWith('wallet.withdrawal.failed', {
      userId: 'u-1',
      amount: 40,
      currency: 'USD',
      transactionId: 'tx-1',
      adminId: 'admin-1',
    });
    expect(events.emit).not.toHaveBeenCalledWith('wallet.withdrawal.completed', expect.anything());
  });

  it('rejects a double-approve (status not pending) as a conflict', async () => {
    const drizzle = makeDrizzle({
      select: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'processing',
            amount: '40',
            currency: 'USD',
          },
        ],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(svc.approveWithdrawal('admin-1', 'tx-1')).rejects.toBeInstanceOf(
      WithdrawalNotPendingError,
    );
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws WithdrawalNotFoundError when missing', async () => {
    const drizzle = makeDrizzle({ select: [[]] });
    const svc = svcOf(drizzle, events, payment);
    await expect(svc.approveWithdrawal('admin-1', 'missing')).rejects.toBeInstanceOf(
      WithdrawalNotFoundError,
    );
  });
});

describe('WalletService.rejectWithdrawal', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('returns funds, sets rejected, and emits rejected with reason', async () => {
    const drizzle = makeDrizzle({
      select: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'pending',
            amount: '40',
            currency: 'USD',
          },
        ],
        [], // awaited balance credit-back update (result unused)
        [{ userId: 'u-1' }], // userIdForWallet
      ],
      returning: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'rejected',
            amount: '40',
            currency: 'USD',
          },
        ],
      ],
    });
    const setSpy = (drizzle.db as unknown as { set: ReturnType<typeof vi.fn> }).set;
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.rejectWithdrawal('admin-1', 'tx-1', 'AML hold');

    expect(result).toEqual({ transactionId: 'tx-1', status: 'rejected' });
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ balance: expect.anything() }));
    expect(events.emit).toHaveBeenCalledWith('wallet.withdrawal.rejected', {
      userId: 'u-1',
      amount: 40,
      currency: 'USD',
      transactionId: 'tx-1',
      adminId: 'admin-1',
      reason: 'AML hold',
    });
  });

  it('rejects a double-reject (status not pending) as a conflict', async () => {
    const drizzle = makeDrizzle({
      select: [
        [
          {
            id: 'tx-1',
            walletId: 'w-1',
            type: 'withdrawal',
            status: 'rejected',
            amount: '40',
            currency: 'USD',
          },
        ],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(svc.rejectWithdrawal('admin-1', 'tx-1', 'again')).rejects.toBeInstanceOf(
      WithdrawalNotPendingError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('WalletService.listPendingWithdrawals', () => {
  const queueRow = (id: string, userId: string) => ({
    tx: {
      id,
      amount: '40',
      currency: 'USD',
      rail: 'psp',
      status: 'pending',
      createdAt: new Date('2026-06-01T00:00:00Z'),
    },
    userId,
  });

  it('enriches rows with username + kycStatus via the directory port', async () => {
    const drizzle = makeDrizzle({ select: [[queueRow('tx-1', 'u-1')]] });
    const directory = makeDirectory([{ userId: 'u-1', username: 'alice', kycStatus: 'verified' }]);
    const svc = svcOf(drizzle, makeEvents(), makePayment(), directory);

    const result = await svc.listPendingWithdrawals({ page: 1, limit: 50 });

    expect(directory.lookupPlayers).toHaveBeenCalledWith(['u-1']);
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      transactionId: 'tx-1',
      username: 'alice',
      kycStatus: 'verified',
      rail: 'psp',
      riskTags: [],
      requestedAt: '2026-06-01T00:00:00.000Z',
    });
  });

  it('applies the kycStatus filter in memory with a correct total and a full page', async () => {
    const rows = [
      queueRow('tx-1', 'u-1'),
      queueRow('tx-2', 'u-2'),
      queueRow('tx-3', 'u-3'),
      queueRow('tx-4', 'u-4'),
    ];
    const drizzle = makeDrizzle({ select: [rows] });
    const directory = makeDirectory([
      { userId: 'u-1', username: 'a', kycStatus: 'verified' },
      { userId: 'u-2', username: 'b', kycStatus: 'pending' },
      { userId: 'u-3', username: 'c', kycStatus: 'verified' },
      { userId: 'u-4', username: 'd', kycStatus: 'verified' },
    ]);
    const svc = svcOf(drizzle, makeEvents(), makePayment(), directory);

    const result = await svc.listPendingWithdrawals({ page: 1, limit: 2, kycStatus: 'verified' });

    // 3 verified rows survive the in-memory filter; total reflects the filtered set, not the page.
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(2);
    expect(result.items.map((i) => i.transactionId)).toEqual(['tx-1', 'tx-3']);
  });

  it('returns the second page sliced from the filtered set', async () => {
    const rows = [queueRow('tx-1', 'u-1'), queueRow('tx-3', 'u-3')];
    const drizzle = makeDrizzle({ select: [rows] });
    const directory = makeDirectory([
      { userId: 'u-1', username: 'a', kycStatus: 'verified' },
      { userId: 'u-3', username: 'c', kycStatus: 'verified' },
    ]);
    const svc = svcOf(drizzle, makeEvents(), makePayment(), directory);

    const result = await svc.listPendingWithdrawals({ page: 2, limit: 1, kycStatus: 'verified' });

    expect(result.total).toBe(2);
    expect(result.items.map((i) => i.transactionId)).toEqual(['tx-3']);
  });
});
