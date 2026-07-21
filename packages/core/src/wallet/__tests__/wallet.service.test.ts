import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mock, readPrivate, makeDrizzle, makeEvents, makePayment } from '../../testing/mock.js';
import {
  WalletService,
  WalletNotFoundError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  InsufficientBalanceError,
  CurrencyMismatchError,
  IdempotencyKeyReuseError,
  DepositAddressUnsupportedError,
  DestinationAddressRequiredError,
} from '../service/wallet.service.js';

type Row = Record<string, unknown>;

function makeDirectory(summaries: Row[] = []) {
  return {
    count: vi.fn(),
    list: vi.fn(),
    get: vi.fn(),
    update: vi.fn(),
    lookupPlayers: vi.fn().mockResolvedValue(summaries),
  };
}

const svcOf = (drizzle: unknown, events: unknown, payment: unknown, directory?: unknown) =>
  new WalletService(
    mock<ConstructorParameters<typeof WalletService>[0]>({ drizzle, events, payment, directory }),
  );

describe('WalletService domain errors', () => {
  it('WalletNotFoundError carries the userId', () => {
    const err = new WalletNotFoundError('user-123');
    expect(err.name).toBe('WalletNotFoundError');
    expect(err.message).toContain('user-123');
  });

  it('InsufficientBalanceError carries available and requested amounts', () => {
    const err = new InsufficientBalanceError('50', '100');
    expect(err.message).toContain('50');
    expect(err.message).toContain('100');
  });
});

describe('WalletService.deposit', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('records the fiat rail for a fiat currency', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '0', currency: 'USD' }], []],
      returning: [[{ id: 'tx-1' }]],
    });
    const valuesSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'values');
    const svc = svcOf(drizzle, events, payment);

    await svc.deposit({ userId: 'u-1', amount: '40', currency: 'USD', provider: 'stripe' });

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'deposit', rail: 'fiat' }),
    );
  });

  it('records the crypto rail for a crypto currency', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '0', currency: 'BTC' }], []],
      returning: [[{ id: 'tx-2' }]],
    });
    const valuesSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'values');
    const svc = svcOf(drizzle, events, payment);

    await svc.deposit({ userId: 'u-1', amount: '1', currency: 'BTC', provider: 'fireblocks' });

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'deposit', rail: 'crypto' }),
    );
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
    const forSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'for');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.withdraw({ userId: 'u-1', amount: '40', currency: 'USD' });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
    expect(forSpy).toHaveBeenCalledWith('update');
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledWith('wallet.withdrawal.requested', {
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      transactionId: 'tx-1',
    });
  });

  it('derives the crypto rail for crypto currencies', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '5', currency: 'BTC' }]],
      returning: [
        [{ id: 'tx-2', walletId: 'w-1', amount: '1', currency: 'BTC', status: 'pending' }],
        [{ id: 'w-1' }],
      ],
    });
    const valuesSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'values');
    const svc = svcOf(drizzle, events, payment);

    await svc.withdraw({
      userId: 'u-1',
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qtest',
    });

    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ rail: 'crypto' }));
  });

  it('throws DestinationAddressRequiredError for a crypto withdrawal with no address', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '5', currency: 'BTC' }]],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(svc.withdraw({ userId: 'u-1', amount: '1', currency: 'BTC' })).rejects.toThrow(
      DestinationAddressRequiredError,
    );
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });

  it('throws CurrencyMismatchError when the request currency differs from the wallet', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }]],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(
      svc.withdraw({ userId: 'u-1', amount: '40', currency: 'EUR' }),
    ).rejects.toBeInstanceOf(CurrencyMismatchError);
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

    await expect(
      svc.withdraw({ userId: 'u-1', amount: '40', currency: 'USD' }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('WalletService.withdraw - synchronous tag evaluation (TAG_EVALUATION_COMMANDS)', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('calls evaluateWithdrawalRequested on the withdrawal transaction handle, with userId/amount, before returning', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }]],
      returning: [
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
        [{ id: 'w-1' }],
      ],
    });
    const tagEvaluationCommands = {
      evaluateWithdrawalRequested: vi.fn().mockResolvedValue(undefined),
    };
    const svc = new WalletService(
      mock<ConstructorParameters<typeof WalletService>[0]>({
        drizzle,
        events,
        payment,
        tagEvaluationCommands,
      }),
    );

    const result = await svc.withdraw({ userId: 'u-1', amount: '40', currency: 'USD' });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
    expect(tagEvaluationCommands.evaluateWithdrawalRequested).toHaveBeenCalledWith(
      expect.anything(),
      { userId: 'u-1', amount: '40' },
    );
  });

  it('is never called when unbound (matches the pre-existing async-event-only behavior)', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }]],
      returning: [
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
        [{ id: 'w-1' }],
      ],
    });
    const svc = svcOf(drizzle, events, payment);
    const result = await svc.withdraw({ userId: 'u-1', amount: '40', currency: 'USD' });
    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
  });

  it('propagates an unexpected error and aborts the withdrawal (fail-closed: a review-gate failure must block the withdrawal, not silently skip review)', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }]],
      returning: [
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
        [{ id: 'w-1' }],
      ],
    });
    const dbError = new Error('tag module db unavailable');
    const tagEvaluationCommands = {
      evaluateWithdrawalRequested: vi.fn().mockRejectedValue(dbError),
    };
    const svc = new WalletService(
      mock<ConstructorParameters<typeof WalletService>[0]>({
        drizzle,
        events,
        payment,
        tagEvaluationCommands,
      }),
    );

    await expect(svc.withdraw({ userId: 'u-1', amount: '40', currency: 'USD' })).rejects.toBe(
      dbError,
    );
    // The transaction rolled back before the requested event/auto-approval step ran.
    expect(events.emit).not.toHaveBeenCalled();
    expect(payment.processWithdrawal).not.toHaveBeenCalled();
  });
});

describe('WalletService idempotency - deposit', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('replay short-circuits BEFORE the PSP call, does not insert again, and does not re-emit', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }],
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'completed' }],
      ],
    });
    const insertSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'insert');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.deposit({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'key-1',
    });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'completed' });
    expect(payment.processDeposit).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws IdempotencyKeyReuseError when a replayed key was used with a different amount', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }],
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'completed' }],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(
      svc.deposit({ userId: 'u-1', amount: '99', currency: 'USD', idempotencyKey: 'key-1' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    expect(payment.processDeposit).not.toHaveBeenCalled();
  });

  it('distinct idempotency keys create distinct transactions', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }], // pre-PSP replay check: wallet lookup
        [], // pre-PSP replay check: no existing tx for key-a
        [], // bare-awaited balance credit for call 1 (no .returning(); reuses pre-PSP wallet)
        [{ id: 'w-1', userId: 'u-1', balance: '140', currency: 'USD' }], // pre-PSP replay check: wallet lookup
        [], // pre-PSP replay check: no existing tx for key-b
        [], // bare-awaited balance credit for call 2 (no .returning())
      ],
      returning: [
        [{ id: 'tx-a', walletId: 'w-1', amount: '40', currency: 'USD', status: 'completed' }],
        [{ id: 'tx-b', walletId: 'w-1', amount: '40', currency: 'USD', status: 'completed' }],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const r1 = await svc.deposit({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'key-a',
    });
    const r2 = await svc.deposit({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'key-b',
    });

    expect(r1.transactionId).toBe('tx-a');
    expect(r2.transactionId).toBe('tx-b');
    expect(events.emit).toHaveBeenCalledTimes(2);
  });

  it('with no idempotencyKey, stores a null key and behaves unchanged', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }],
        [], // bare-awaited balance credit (no .returning())
      ],
      returning: [
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'completed' }],
      ],
    });
    const valuesSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'values');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.deposit({ userId: 'u-1', amount: '40', currency: 'USD' });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'completed' });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: null }));
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.deposit.completed',
      expect.objectContaining({ transactionId: 'tx-1' }),
    );
  });

  it('a race on the partial unique index re-reads the winner instead of aborting the transaction', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }], // pre-PSP replay check: wallet lookup
        [], // pre-PSP replay check: not found yet, both requests race past it
        [
          {
            id: 'tx-winner',
            walletId: 'w-1',
            amount: '40',
            currency: 'USD',
            status: 'completed',
          },
        ], // txn: re-read after the conflicting insert
      ],
      returning: [
        [], // onConflictDoNothing().returning() - the loser's insert is a no-op, not a thrown error
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.deposit({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'key-1',
    });

    expect(result).toEqual({ transactionId: 'tx-winner', status: 'completed' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws IdempotencyKeyReuseError when a replayed key was used with a different currency', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }],
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'completed' }],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(
      svc.deposit({ userId: 'u-1', amount: '40', currency: 'EUR', idempotencyKey: 'key-1' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    expect(payment.processDeposit).not.toHaveBeenCalled();
  });
});

describe('WalletService idempotency - withdraw', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('replay returns the first stored transaction, does not insert again, and does not re-emit', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '60', currency: 'USD' }],
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
      ],
    });
    const insertSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'insert');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.withdraw({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'key-1',
    });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
    expect(insertSpy).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws IdempotencyKeyReuseError when a replayed key was used with a different amount', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '60', currency: 'USD' }],
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(
      svc.withdraw({ userId: 'u-1', amount: '99', currency: 'USD', idempotencyKey: 'key-1' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  it('distinct idempotency keys create distinct transactions', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }],
        [], // no existing tx for key-a
        [{ id: 'w-1', userId: 'u-1', balance: '60', currency: 'USD' }],
        [], // no existing tx for key-b
      ],
      returning: [
        [{ id: 'tx-a', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
        [{ id: 'w-1' }], // guarded debit for call 1
        [{ id: 'tx-b', walletId: 'w-1', amount: '20', currency: 'USD', status: 'pending' }],
        [{ id: 'w-1' }], // guarded debit for call 2
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const r1 = await svc.withdraw({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'key-a',
    });
    const r2 = await svc.withdraw({
      userId: 'u-1',
      amount: '20',
      currency: 'USD',
      idempotencyKey: 'key-b',
    });

    expect(r1.transactionId).toBe('tx-a');
    expect(r2.transactionId).toBe('tx-b');
    expect(events.emit).toHaveBeenCalledTimes(2);
  });

  it('with no idempotencyKey, stores a null key and behaves unchanged', async () => {
    const drizzle = makeDrizzle({
      select: [[{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }]],
      returning: [
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
        [{ id: 'w-1' }],
      ],
    });
    const valuesSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'values');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.withdraw({ userId: 'u-1', amount: '40', currency: 'USD' });

    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
    expect(valuesSpy).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: null }));
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.withdrawal.requested',
      expect.objectContaining({ transactionId: 'tx-1' }),
    );
  });

  it('a race on the partial unique index re-reads the winner instead of aborting the transaction', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }],
        [], // pre-insert check: not found yet, both requests race past it
        [{ id: 'tx-winner', walletId: 'w-1', amount: '40', currency: 'USD', status: 'pending' }],
      ],
      returning: [
        [], // onConflictDoNothing().returning() - the loser's insert is a no-op, not a thrown error
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.withdraw({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'key-1',
    });

    expect(result).toEqual({ transactionId: 'tx-winner', status: 'pending' });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws IdempotencyKeyReuseError when a replayed key was used with a different currency', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '60', currency: 'USD' }],
        [{ id: 'tx-1', walletId: 'w-1', amount: '40', currency: 'EUR', status: 'pending' }],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    await expect(
      svc.withdraw({ userId: 'u-1', amount: '40', currency: 'USD', idempotencyKey: 'key-1' }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });
});

describe('WalletService idempotency - namespaced across operations', () => {
  let events: ReturnType<typeof makeEvents>;
  let payment: ReturnType<typeof makePayment>;

  beforeEach(() => {
    events = makeEvents();
    payment = makePayment();
  });

  it('the same raw key used for a deposit then a withdraw creates two distinct rows, not a false replay', async () => {
    const drizzle = makeDrizzle({
      select: [
        [{ id: 'w-1', userId: 'u-1', balance: '100', currency: 'USD' }], // deposit pre-PSP: wallet lookup
        [], // deposit pre-PSP: no existing tx under the deposit namespace
        [], // bare-awaited balance credit (no .returning())
        [{ id: 'w-1', userId: 'u-1', balance: '140', currency: 'USD' }], // withdraw: current (for update)
        [], // withdraw pre-insert check: no existing tx under the withdraw namespace
      ],
      returning: [
        [
          {
            id: 'tx-deposit',
            walletId: 'w-1',
            amount: '40',
            currency: 'USD',
            status: 'completed',
          },
        ],
        [
          {
            id: 'tx-withdraw',
            walletId: 'w-1',
            amount: '40',
            currency: 'USD',
            status: 'pending',
          },
        ],
        [{ id: 'w-1' }], // withdraw guarded debit
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const deposit = await svc.deposit({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'shared-key',
    });
    const withdraw = await svc.withdraw({
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      idempotencyKey: 'shared-key',
    });

    expect(deposit.transactionId).toBe('tx-deposit');
    expect(withdraw.transactionId).toBe('tx-withdraw');
    expect(deposit.transactionId).not.toBe(withdraw.transactionId);
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.deposit.completed',
      expect.objectContaining({ transactionId: 'tx-deposit' }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.withdrawal.requested',
      expect.objectContaining({ transactionId: 'tx-withdraw' }),
    );
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
            rail: 'fiat',
          },
        ],
      ],
    });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'set');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.approveWithdrawal('admin-1', 'tx-1');

    expect(result).toEqual({ transactionId: 'tx-1', status: 'completed' });
    expect(payment.processWithdrawal).toHaveBeenCalledWith('40', 'USD', {
      transactionId: 'tx-1',
      userId: 'u-1',
      rail: 'fiat',
      adminId: 'admin-1',
    });
    // The PSP reference and derived provider name persist on the completing update.
    expect(setSpy).toHaveBeenCalledWith({
      status: 'completed',
      providerName: 'psp',
      providerRefId: 'ext-2',
    });
    expect(events.emit).toHaveBeenNthCalledWith(1, 'wallet.withdrawal.approved', {
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      transactionId: 'tx-1',
      adminId: 'admin-1',
    });
    expect(events.emit).toHaveBeenNthCalledWith(2, 'wallet.withdrawal.completed', {
      userId: 'u-1',
      amount: '40',
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
        [{ id: 'tx-1' }],
      ],
    });
    payment.processWithdrawal.mockRejectedValueOnce(new Error('psp down'));
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'set');
    const svc = svcOf(drizzle, events, payment);

    await expect(svc.approveWithdrawal('admin-1', 'tx-1')).rejects.toThrow('psp down');

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ balance: expect.anything() }));
    expect(events.emit).toHaveBeenCalledWith('wallet.withdrawal.failed', {
      userId: 'u-1',
      amount: '40',
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
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'set');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.rejectWithdrawal('admin-1', 'tx-1', 'AML hold');

    expect(result).toEqual({ transactionId: 'tx-1', status: 'rejected' });
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ balance: expect.anything() }));
    expect(events.emit).toHaveBeenCalledWith('wallet.withdrawal.rejected', {
      userId: 'u-1',
      amount: '40',
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

describe('WalletService.listWithdrawals', () => {
  const queueRow = (id: string, userId: string, overrides: Row = {}) => ({
    tx: {
      id,
      walletId: 'w-1',
      amount: '40',
      currency: 'USD',
      rail: 'fiat',
      status: 'pending',
      createdAt: new Date('2026-06-01T00:00:00Z'),
      ...overrides,
    },
    userId,
  });

  it('enriches rows with username + kycStatus via the directory port', async () => {
    const drizzle = makeDrizzle({ select: [[queueRow('tx-1', 'u-1')]] });
    const directory = makeDirectory([{ userId: 'u-1', username: 'alice', kycStatus: 'verified' }]);
    const svc = svcOf(drizzle, makeEvents(), makePayment(), directory);

    const result = await svc.listWithdrawals({ page: 1, limit: 50 });

    expect(directory.lookupPlayers).toHaveBeenCalledWith(['u-1']);
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({
      transactionId: 'tx-1',
      username: 'alice',
      kycStatus: 'verified',
      rail: 'fiat',
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

    const result = await svc.listWithdrawals({ page: 1, limit: 2, kycStatus: 'verified' });

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

    const result = await svc.listWithdrawals({ page: 2, limit: 1, kycStatus: 'verified' });

    expect(result.total).toBe(2);
    expect(result.items.map((i) => i.transactionId)).toEqual(['tx-3']);
  });

  it('returns rows of any status when no status filter is given (not pending-only)', async () => {
    const rows = [
      queueRow('tx-1', 'u-1', { status: 'pending' }),
      queueRow('tx-2', 'u-2', { status: 'completed' }),
      queueRow('tx-3', 'u-3', { status: 'rejected' }),
    ];
    const drizzle = makeDrizzle({ select: [rows] });
    const svc = svcOf(drizzle, makeEvents(), makePayment(), makeDirectory());

    const result = await svc.listWithdrawals({ page: 1, limit: 50 });

    expect(result.total).toBe(3);
    expect(result.items.map((i) => i.status)).toEqual(['pending', 'completed', 'rejected']);
  });

  it('tags large_amount when the amount is at/above the threshold, not below', async () => {
    const big = makeDrizzle({
      select: [[queueRow('tx-1', 'u-1', { amount: '5000' })], []],
    });
    const small = makeDrizzle({
      select: [[queueRow('tx-2', 'u-2', { amount: '4999.99' })], []],
    });

    const bigResult = await svcOf(
      big,
      makeEvents(),
      makePayment(),
      makeDirectory(),
    ).listWithdrawals({ page: 1, limit: 50 });
    const smallResult = await svcOf(
      small,
      makeEvents(),
      makePayment(),
      makeDirectory(),
    ).listWithdrawals({ page: 1, limit: 50 });

    expect(bigResult.items[0]?.riskTags).toContain('large_amount');
    expect(smallResult.items[0]?.riskTags).not.toContain('large_amount');
  });

  it('tags high_frequency when the grouped 24h count is >= 3 for the wallet, not below', async () => {
    // Second select entry = the batched velocity count query result.
    const frequent = makeDrizzle({
      select: [[queueRow('tx-1', 'u-1')], [{ walletId: 'w-1', n: 3 }]],
    });
    const rare = makeDrizzle({
      select: [[queueRow('tx-2', 'u-2')], [{ walletId: 'w-1', n: 2 }]],
    });

    const frequentResult = await svcOf(
      frequent,
      makeEvents(),
      makePayment(),
      makeDirectory(),
    ).listWithdrawals({ page: 1, limit: 50 });
    const rareResult = await svcOf(
      rare,
      makeEvents(),
      makePayment(),
      makeDirectory(),
    ).listWithdrawals({ page: 1, limit: 50 });

    expect(frequentResult.items[0]?.riskTags).toContain('high_frequency');
    expect(rareResult.items[0]?.riskTags).not.toContain('high_frequency');
  });
});

describe('WalletService.approveWithdrawal - async vendor', () => {
  it('leaves the withdrawal processing (not completed) when the vendor returns a non-terminal status', async () => {
    const events = makeEvents();
    const payment = makePayment();
    payment.processWithdrawal.mockResolvedValueOnce({ externalId: 'ext-3', status: 'processing' });
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
        [{ userId: 'u-1' }],
        [],
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
            rail: 'fiat',
          },
        ],
      ],
    });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'set');
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.approveWithdrawal('admin-1', 'tx-1');

    expect(result).toEqual({ transactionId: 'tx-1', status: 'processing' });
    expect(setSpy).toHaveBeenCalledWith({ providerName: 'psp', providerRefId: 'ext-3' });
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.withdrawal.approved',
      expect.objectContaining({ transactionId: 'tx-1' }),
    );
    expect(events.emit).not.toHaveBeenCalledWith('wallet.withdrawal.completed', expect.anything());
  });
});

describe('WalletService.reconcileWithdrawalStatus', () => {
  const PROCESSING_TX = {
    id: 'tx-1',
    walletId: 'w-1',
    type: 'withdrawal',
    status: 'processing',
    amount: '40',
    currency: 'USD',
  };

  it('completed: transitions processing -> completed and emits wallet.withdrawal.completed', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({
      select: [[PROCESSING_TX], [{ userId: 'u-1' }]],
      returning: [[{ id: 'tx-1' }]],
    });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'set');
    const svc = svcOf(drizzle, events, makePayment());

    await svc.reconcileWithdrawalStatus({
      kind: 'withdrawal',
      externalId: 'ext-9',
      status: 'completed',
    });

    expect(setSpy).toHaveBeenCalledWith({ status: 'completed' });
    expect(events.emit).toHaveBeenCalledWith('wallet.withdrawal.completed', {
      userId: 'u-1',
      amount: '40',
      currency: 'USD',
      transactionId: 'tx-1',
    });
  });

  it('failed: refunds and marks failed, without an admin-attributed event (system/webhook-driven)', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({
      select: [[PROCESSING_TX], [{ userId: 'u-1' }], []],
      returning: [[{ id: 'tx-1' }]],
    });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'set');
    const svc = svcOf(drizzle, events, makePayment());

    await svc.reconcileWithdrawalStatus({
      kind: 'withdrawal',
      externalId: 'ext-9',
      status: 'failed',
    });

    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ balance: expect.anything() }));
    expect(events.emit).not.toHaveBeenCalledWith('wallet.withdrawal.failed', expect.anything());
  });

  it('no-ops when the transaction is already terminal (idempotent replay)', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({ select: [[{ ...PROCESSING_TX, status: 'completed' }]] });
    const setSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'set');
    const svc = svcOf(drizzle, events, makePayment());

    await svc.reconcileWithdrawalStatus({
      kind: 'withdrawal',
      externalId: 'ext-9',
      status: 'completed',
    });

    expect(setSpy).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('no-ops when no transaction matches the providerRefId', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({ select: [[]] });
    const svc = svcOf(drizzle, events, makePayment());

    await svc.reconcileWithdrawalStatus({
      kind: 'withdrawal',
      externalId: 'unknown',
      status: 'completed',
    });

    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('WalletService.getOrCreateDepositAddress', () => {
  it('returns an already-issued address without calling the adapter again', async () => {
    const events = makeEvents();
    const payment = makePayment();
    const drizzle = makeDrizzle({
      select: [
        [
          {
            id: 'da-1',
            userId: 'u-1',
            currency: 'BTC',
            address: 'bc1qexisting',
            providerName: 'fireblocks',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.getOrCreateDepositAddress('u-1', 'BTC');

    expect(result).toEqual({ address: 'bc1qexisting', currency: 'BTC' });
  });

  it('issues and persists a new address on the first call', async () => {
    const events = makeEvents();
    const payment = {
      ...makePayment(),
      issueDepositAddress: vi.fn().mockResolvedValue({ address: 'bc1qnew' }),
    };
    const drizzle = makeDrizzle({
      select: [[]],
      returning: [
        [
          {
            id: 'da-2',
            userId: 'u-1',
            currency: 'BTC',
            address: 'bc1qnew',
            providerName: 'fireblocks',
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ],
      ],
    });
    const svc = svcOf(drizzle, events, payment);

    const result = await svc.getOrCreateDepositAddress('u-1', 'BTC');

    expect(result).toEqual({ address: 'bc1qnew', currency: 'BTC' });
    expect(payment.issueDepositAddress).toHaveBeenCalledWith('u-1', 'BTC');
  });

  it('throws DepositAddressUnsupportedError when the bound adapter has no issueDepositAddress', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({ select: [[]] });
    const svc = svcOf(drizzle, events, makePayment());

    await expect(svc.getOrCreateDepositAddress('u-1', 'BTC')).rejects.toBeInstanceOf(
      DepositAddressUnsupportedError,
    );
  });
});

describe('WalletService.creditDepositByAddress', () => {
  const DEPOSIT_ADDRESS_ROW = {
    id: 'da-1',
    userId: 'u-1',
    currency: 'BTC',
    address: 'bc1qxyz',
    providerName: 'fireblocks',
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
  const WALLET_ROW = { id: 'w-1', userId: 'u-1', balance: '0', currency: 'BTC' };
  const EVENT = {
    kind: 'deposit' as const,
    address: 'bc1qxyz',
    amount: '0.5',
    currency: 'BTC',
    txHash: '0xabc',
    externalId: 'vendor-ext-1',
  };

  it('resolves the address, credits the wallet, and emits wallet.deposit.completed', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({
      select: [[DEPOSIT_ADDRESS_ROW], [WALLET_ROW], []],
      returning: [[{ id: 'tx-1', walletId: 'w-1' }]],
    });
    const valuesSpy = readPrivate<ReturnType<typeof vi.fn>>(drizzle.db, 'values');
    const svc = svcOf(drizzle, events, makePayment());

    await svc.creditDepositByAddress(EVENT);

    expect(valuesSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'deposit',
        providerRefId: 'vendor-ext-1',
        destinationAddress: 'bc1qxyz',
        txHash: '0xabc',
      }),
    );
    expect(events.emit).toHaveBeenCalledWith('wallet.deposit.completed', {
      userId: 'u-1',
      amount: '0.5',
      currency: 'BTC',
      transactionId: 'tx-1',
    });
  });

  it('logs and no-ops when the address is unknown', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({ select: [[]] });
    const svc = svcOf(drizzle, events, makePayment());

    await svc.creditDepositByAddress(EVENT);

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('is idempotent on a replayed externalId: re-reads the winner instead of double-crediting', async () => {
    const events = makeEvents();
    const drizzle = makeDrizzle({
      select: [
        [DEPOSIT_ADDRESS_ROW],
        [WALLET_ROW],
        [{ id: 'tx-1', walletId: 'w-1', providerRefId: 'vendor-ext-1' }],
      ],
      returning: [[]],
    });
    const svc = svcOf(drizzle, events, makePayment());

    await svc.creditDepositByAddress(EVENT);

    expect(events.emit).not.toHaveBeenCalled();
  });
});
