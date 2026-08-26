import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  DEFAULT_PAYMENT_PROVIDER,
  type AdminUserDirectory,
  type PaymentAdapter,
  type AdminPlayerSummary,
  type TagEvaluationCommands,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  NO_CLIENT_META,
  makeAuditWriter,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletDepositAddress,
  walletAsset,
  walletReconciliationFinding,
  walletWithdrawalAddress,
} from '../schema/index.js';
import {
  WalletService,
  type WalletServiceDeps,
  WalletNotFoundError,
  WithdrawalNotFoundError,
  WithdrawalNotPendingError,
  InsufficientBalanceError,
  AmbiguousDepositAddressError,
  IdempotencyKeyReuseError,
  DepositAddressUnsupportedError,
  DestinationAddressRequiredError,
  AmbiguousNetworkError,
  BelowMinimumWithdrawalError,
  WithdrawalDisabledError,
  DestinationAddressNotWhitelistedError,
} from '../service/wallet.service.js';
import { WithdrawalQueueItemSchema } from '../contract/index.js';

let db: TestDb;

type PspResult = Awaited<ReturnType<PaymentAdapter['processWithdrawal']>>;

function makePsp() {
  const settled = async (): Promise<PspResult> => ({
    externalId: randomUUID(),
    status: 'completed',
  });
  return { processDeposit: vi.fn(settled), processWithdrawal: vi.fn(settled) };
}

function makeService(overrides: Partial<WalletServiceDeps> = {}) {
  const events = makeEventBus();
  const psp = makePsp();
  const audit = makeAuditWriter();
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: events,
    payment: mock<PaymentAdapter>(psp),
    paymentProviders: makePaymentProviderRegistry(),
    audit,
    identityReader: makeIdentityReader(),
    ...overrides,
  });
  return { svc, events, psp, audit };
}

function playerIdentityReader() {
  const identityReader = makeIdentityReader();
  vi.mocked(identityReader.getPlayerIdByUserId).mockResolvedValue(randomUUID());
  return identityReader;
}

const queueService = () => makeService().svc;

function makeDirectory(summaries: AdminPlayerSummary[]) {
  return mock<AdminUserDirectory>({
    lookupPlayers: vi.fn(async (ids: string[]) => summaries.filter((s) => ids.includes(s.userId))),
  });
}

async function seedWallet({
  balance = '0',
  ...overrides
}: Partial<typeof wallet.$inferInsert> & { balance?: string } = {}) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: randomUUID(), currency: 'USD', ...overrides })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: balance });
  return row;
}

async function seedTx(
  walletId: string,
  overrides: Partial<typeof walletTransaction.$inferInsert> = {},
) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'withdrawal',
        amount: '10',
        currency: 'USD',
        status: 'pending',
        rail: 'fiat',
        ...overrides,
      })
      .returning(),
    new Error('seedTx: query returned no row'),
  );
  return row;
}

async function balanceOf(userId: string, currency?: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(
      and(
        eq(wallet.userId, userId),
        currency
          ? eq(walletBalance.currency, currency)
          : eq(walletBalance.currency, wallet.currency),
      ),
    );
  return Number(row?.amount ?? 0);
}

async function txRows(walletId: string) {
  return db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
}

async function txById(id: string) {
  const row = findOneOrThrow(
    await db.drizzle.db.select().from(walletTransaction).where(eq(walletTransaction.id, id)),
    new Error('txById: query returned no row'),
  );
  return row;
}

const emittedTopics = (events: ReturnType<typeof makeEventBus>) =>
  events.emit.mock.calls.map(([topic]) => topic);

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletDepositAddress}, ${walletAsset}, ${walletReconciliationFinding}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.deposit (real PG)', () => {
  it('creates the wallet on a first deposit, credits it, and writes one completed fiat ledger row', async () => {
    const { svc, events, psp } = makeService();
    const userId = randomUUID();
    const externalId = randomUUID();
    psp.processDeposit.mockResolvedValueOnce({ externalId, status: 'completed' });

    const result = await svc.deposit({
      userId,
      amount: '40',
      currency: 'USD',
      provider: 'stripe',
    });

    expect(result.status).toBe('completed');
    expect(await balanceOf(userId)).toBe(40);
    const [created] = await db.drizzle.db.select().from(wallet).where(eq(wallet.userId, userId));
    const rows = await txRows(created!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'deposit',
      status: 'completed',
      rail: 'fiat',
      providerName: 'stripe',
      providerRefId: externalId,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.deposit.completed',
      expect.objectContaining({ userId, amount: '40', transactionId: result.transactionId }),
    );
  });

  it('records the crypto rail for a crypto currency', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ currency: 'BTC' });

    await svc.deposit({ userId: w.userId, amount: '1', currency: 'BTC', provider: 'custody' });

    const rows = await txRows(w.id);
    expect(rows[0]).toMatchObject({ type: 'deposit', rail: 'crypto' });
  });

  it('accumulates repeated deposits with SQL numeric arithmetic', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '10.5' });

    await svc.deposit({ userId: w.userId, amount: '0.25', currency: 'USD' });
    await svc.deposit({ userId: w.userId, amount: '0.25', currency: 'USD' });

    expect(await balanceOf(w.userId)).toBe(11);
  });

  it('credits the wallet currency row when the deposit currency differs only in case', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '10', currency: 'USD' });

    await svc.deposit({ userId: w.userId, amount: '5', currency: 'usd' });

    const rows = await db.drizzle.db
      .select()
      .from(walletBalance)
      .where(eq(walletBalance.walletId, w.id));
    expect(rows).toHaveLength(1);
    expect(await balanceOf(w.userId)).toBe(15);
  });

  it('credits a second currency into its own balance row, leaving the active-currency balance untouched', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100', currency: 'USD' });

    await svc.deposit({ userId: w.userId, amount: '10', currency: 'EUR' });

    expect(await balanceOf(w.userId, 'USD')).toBe(100);
    expect(await balanceOf(w.userId, 'EUR')).toBe(10);
  });
});

describe('WalletService.manualAdjust (real PG)', () => {
  it('credits, debits, writes an immutable ledger row and replays exactly once', async () => {
    const { svc, audit, psp } = makeService({ identityReader: playerIdentityReader() });
    const player = await seedWallet({ balance: '10' });
    const adminId = randomUUID();
    const idempotencyKey = randomUUID();

    const credit = await svc.manualAdjust({
      adminId,
      userId: player.userId,
      direction: 'credit',
      amount: '5',
      currency: 'USD',
      reason: 'settlement correction',
      idempotencyKey,
      ...NO_CLIENT_META,
    });
    const replay = await svc.manualAdjust({
      adminId,
      userId: player.userId,
      direction: 'credit',
      amount: '5',
      currency: 'USD',
      reason: 'settlement correction',
      idempotencyKey,
      ...NO_CLIENT_META,
    });
    const debit = await svc.manualAdjust({
      adminId,
      userId: player.userId,
      direction: 'debit',
      amount: '3',
      currency: 'USD',
      reason: 'duplicate credit reversal',
      idempotencyKey: randomUUID(),
      ...NO_CLIENT_META,
    });

    expect(replay).toEqual(credit);
    expect(await balanceOf(player.userId)).toBe(12);
    expect(await txById(credit.transactionId)).toMatchObject({
      type: 'manual_credit',
      status: 'completed',
      reviewedBy: adminId,
      reviewReason: 'settlement correction',
    });
    expect(await txById(debit.transactionId)).toMatchObject({ type: 'manual_debit' });
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(2);
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'wallet.manual_adjustment.created',
        actorId: adminId,
        resourceId: credit.transactionId,
      }),
    );
    expect(psp.processDeposit).not.toHaveBeenCalled();
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
  });

  it('rejects an overdraw without a ledger or audit entry', async () => {
    const { svc, audit } = makeService({ identityReader: playerIdentityReader() });
    const player = await seedWallet({ balance: '10' });

    await expect(
      svc.manualAdjust({
        adminId: randomUUID(),
        userId: player.userId,
        direction: 'debit',
        amount: '11',
        currency: 'USD',
        reason: 'correction',
        idempotencyKey: randomUUID(),
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    expect(await balanceOf(player.userId)).toBe(10);
    expect(await txRows(player.id)).toHaveLength(0);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('creates a selected-currency balance for a player without a wallet', async () => {
    const { svc } = makeService({ identityReader: playerIdentityReader() });
    const userId = randomUUID();

    await svc.manualAdjust({
      adminId: randomUUID(),
      userId,
      direction: 'credit',
      amount: '7',
      currency: 'EUR',
      reason: 'goodwill',
      idempotencyKey: randomUUID(),
      ...NO_CLIENT_META,
    });

    expect(await svc.getBalances(userId)).toEqual({
      activeCurrency: 'EUR',
      balances: [{ currency: 'EUR', balance: '7.000000000000000000' }],
    });
  });
});

describe('WalletService.getBalances / setActiveCurrency (real PG)', () => {
  it('returns every held currency ordered by code alongside the active one', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100', currency: 'USD' });
    await svc.deposit({ userId: w.userId, amount: '10', currency: 'EUR' });

    expect(await svc.getBalances(w.userId)).toEqual({
      activeCurrency: 'USD',
      balances: [
        { currency: 'EUR', balance: '10.000000000000000000' },
        { currency: 'USD', balance: '100.000000000000000000' },
      ],
    });
  });

  it('reads as the default currency with no balances when the user has no wallet, matching getBalance', async () => {
    const { svc } = makeService();
    const userId = randomUUID();

    expect(await svc.getBalances(userId)).toEqual({ activeCurrency: 'USD', balances: [] });
    expect(await svc.getBalance(userId)).toEqual({ balance: '0', currency: 'USD' });
  });

  it('switches the active currency so getBalance reads the new one', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100', currency: 'USD' });
    await svc.deposit({ userId: w.userId, amount: '10', currency: 'EUR' });

    expect(await svc.setActiveCurrency(w.userId, 'EUR')).toEqual({ activeCurrency: 'EUR' });
    expect(await svc.getBalance(w.userId)).toMatchObject({ currency: 'EUR' });
  });

  it('throws WalletNotFoundError when setting the active currency without a wallet', async () => {
    const { svc } = makeService();

    await expect(svc.setActiveCurrency(randomUUID(), 'EUR')).rejects.toBeInstanceOf(
      WalletNotFoundError,
    );
  });
});

describe('WalletService.withdraw (real PG)', () => {
  it('holds the funds immediately, leaves the row pending, and emits requested', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ balance: '100' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(await balanceOf(w.userId)).toBe(60);
    expect(await txById(result.transactionId)).toMatchObject({
      type: 'withdrawal',
      status: 'pending',
      rail: 'fiat',
    });
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.withdrawal.requested',
      expect.objectContaining({ userId: w.userId, amount: '40', ip: null, userAgent: null }),
    );
  });

  it('stores the destination address and the crypto rail for a crypto withdrawal', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '2', currency: 'BTC' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });

    expect(await txById(result.transactionId)).toMatchObject({
      rail: 'crypto',
      destinationAddress: 'bc1qexample',
    });
  });

  it('pins the only payable network on the transaction', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '2', currency: 'BTC' });
    await db.drizzle.db.insert(walletAsset).values({
      currency: 'BTC',
      network: 'BITCOIN',
      providerAssetId: 'BTC',
      minDeposit: '0',
      minWithdrawal: '0',
      withdrawalFee: '0',
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });

    expect(await txById(result.transactionId)).toMatchObject({ network: 'BITCOIN' });
  });

  it('demands a network when the currency is payable on several, holding no funds', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100', currency: 'USDT' });
    await db.drizzle.db.insert(walletAsset).values(
      ['ERC20', 'TRC20'].map((network) => ({
        currency: 'USDT',
        network,
        providerAssetId: `USDT_${network}`,
        minDeposit: '0',
        minWithdrawal: '0',
        withdrawalFee: '0',
      })),
    );

    await expect(
      svc.withdraw({
        userId: w.userId,
        amount: '10',
        currency: 'USDT',
        destinationAddress: '0xexample',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(AmbiguousNetworkError);
    expect(await balanceOf(w.userId)).toBe(100);
  });

  it('enforces the minimum of the chosen chain, not the currency', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100', currency: 'USDT' });
    await db.drizzle.db.insert(walletAsset).values([
      {
        currency: 'USDT',
        network: 'ERC20',
        providerAssetId: 'USDT_ERC20',
        minDeposit: '0',
        minWithdrawal: '20',
        withdrawalFee: '0',
      },
      {
        currency: 'USDT',
        network: 'BEP20',
        providerAssetId: 'USDT_BSC',
        minDeposit: '0',
        minWithdrawal: '1',
        withdrawalFee: '0',
      },
    ]);
    const args = {
      userId: w.userId,
      amount: '5',
      currency: 'USDT',
      destinationAddress: '0xexample',
      ...NO_CLIENT_META,
    };

    await expect(svc.withdraw({ ...args, network: 'ERC20' })).rejects.toBeInstanceOf(
      BelowMinimumWithdrawalError,
    );
    const ok = await svc.withdraw({ ...args, network: 'BEP20' });

    expect(await txById(ok.transactionId)).toMatchObject({ network: 'BEP20' });
  });

  it('fails closed when the currency is configured but payable nowhere', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100', currency: 'USDT' });
    await db.drizzle.db.insert(walletAsset).values({
      currency: 'USDT',
      network: 'ERC20',
      providerAssetId: 'USDT_ERC20',
      minDeposit: '0',
      minWithdrawal: '0',
      withdrawalFee: '0',
      withdrawalEnabled: false,
    });

    await expect(
      svc.withdraw({
        userId: w.userId,
        amount: '10',
        currency: 'USDT',
        destinationAddress: '0xexample',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(WithdrawalDisabledError);
    expect(await balanceOf(w.userId)).toBe(100);
  });

  it('throws DestinationAddressRequiredError for a crypto withdrawal with no address', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '2', currency: 'BTC' });

    await expect(
      svc.withdraw({ userId: w.userId, amount: '1', currency: 'BTC', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(DestinationAddressRequiredError);
    expect(await balanceOf(w.userId)).toBe(2);
  });

  it('throws InsufficientBalanceError when withdrawing a currency the wallet holds no balance in', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100', currency: 'USD' });

    await expect(
      svc.withdraw({ userId: w.userId, amount: '10', currency: 'EUR', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(await balanceOf(w.userId, 'USD')).toBe(100);
  });

  it('throws WalletNotFoundError when the user has no wallet', async () => {
    const { svc } = makeService();

    await expect(
      svc.withdraw({ userId: randomUUID(), amount: '10', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(WalletNotFoundError);
  });

  it('rolls the whole transaction back when the guarded debit finds too little balance', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ balance: '30' });

    await expect(
      svc.withdraw({ userId: w.userId, amount: '40', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(InsufficientBalanceError);

    expect(await balanceOf(w.userId)).toBe(30);
    expect(await txRows(w.id)).toHaveLength(0);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('lets two concurrent withdrawals share a balance without overdrawing it', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100' });

    const settled = await Promise.allSettled([
      svc.withdraw({ userId: w.userId, amount: '60', currency: 'USD', ...NO_CLIENT_META }),
      svc.withdraw({ userId: w.userId, amount: '60', currency: 'USD', ...NO_CLIENT_META }),
    ]);

    expect(settled.filter((s) => s.status === 'fulfilled')).toHaveLength(1);
    expect(await balanceOf(w.userId)).toBe(40);
    expect(await txRows(w.id)).toHaveLength(1);
  });
});

describe('WalletService.withdraw - synchronous tag evaluation (TAG_EVALUATION_COMMANDS) (real PG)', () => {
  it('calls evaluateWithdrawalRequested on the withdrawal transaction handle, with userId/amount, before returning', async () => {
    const tagEvaluationCommands = mock<TagEvaluationCommands>({
      evaluateWithdrawalRequested: vi.fn().mockResolvedValue(undefined),
    });
    const { svc } = makeService({ tagEvaluationCommands });
    const w = await seedWallet({ balance: '100' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
    expect(tagEvaluationCommands.evaluateWithdrawalRequested).toHaveBeenCalledWith(
      expect.anything(),
      { userId: w.userId, amount: '40' },
    );
  });

  it('is never called when unbound (matches the pre-existing async-event-only behavior)', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      ...NO_CLIENT_META,
    });

    expect(result.status).toBe('pending');
  });

  it('propagates an unexpected error and aborts the withdrawal (fail-closed: a review-gate failure must block the withdrawal, not silently skip review)', async () => {
    const dbError = new Error('tag module db unavailable');
    const tagEvaluationCommands = mock<TagEvaluationCommands>({
      evaluateWithdrawalRequested: vi.fn().mockRejectedValue(dbError),
    });
    const { svc, events, psp } = makeService({ tagEvaluationCommands });
    const w = await seedWallet({ balance: '100' });

    await expect(
      svc.withdraw({ userId: w.userId, amount: '40', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toBe(dbError);
    // The transaction rolled back before the requested event/auto-approval step ran.
    expect(events.emit).not.toHaveBeenCalled();
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
    expect(await balanceOf(w.userId)).toBe(100);
  });
});

describe('WalletService idempotency - deposit (real PG)', () => {
  it('replays before the PSP call: one row, one credit, one event', async () => {
    const { svc, events, psp } = makeService();
    const w = await seedWallet();
    const idempotencyKey = randomUUID();

    const first = await svc.deposit({
      userId: w.userId,
      amount: '25',
      currency: 'USD',
      idempotencyKey,
    });
    const replay = await svc.deposit({
      userId: w.userId,
      amount: '25',
      currency: 'USD',
      idempotencyKey,
    });

    expect(replay.transactionId).toBe(first.transactionId);
    expect(psp.processDeposit).toHaveBeenCalledTimes(1);
    expect(await txRows(w.id)).toHaveLength(1);
    expect(await balanceOf(w.userId)).toBe(25);
    expect(emittedTopics(events)).toEqual(['wallet.deposit.completed']);
  });

  it('throws IdempotencyKeyReuseError when the key is replayed with a different amount', async () => {
    const { svc } = makeService();
    const w = await seedWallet();
    const idempotencyKey = randomUUID();
    await svc.deposit({ userId: w.userId, amount: '25', currency: 'USD', idempotencyKey });

    await expect(
      svc.deposit({ userId: w.userId, amount: '26', currency: 'USD', idempotencyKey }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    expect(await balanceOf(w.userId)).toBe(25);
  });

  it('treats an unnormalized replay amount as a match, not a reuse', async () => {
    const { svc } = makeService();
    const w = await seedWallet();
    const idempotencyKey = randomUUID();
    const first = await svc.deposit({
      userId: w.userId,
      amount: '25.00',
      currency: 'USD',
      idempotencyKey,
    });

    const replay = await svc.deposit({
      userId: w.userId,
      amount: '25',
      currency: 'USD',
      idempotencyKey,
    });

    expect(replay.transactionId).toBe(first.transactionId);
  });

  it('distinct idempotency keys create distinct transactions', async () => {
    const { svc } = makeService();
    const w = await seedWallet();

    const a = await svc.deposit({
      userId: w.userId,
      amount: '10',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    });
    const b = await svc.deposit({
      userId: w.userId,
      amount: '10',
      currency: 'USD',
      idempotencyKey: randomUUID(),
    });

    expect(a.transactionId).not.toBe(b.transactionId);
    expect(await balanceOf(w.userId)).toBe(20);
  });

  it('stores a null key and credits every call when no idempotencyKey is given', async () => {
    const { svc } = makeService();
    const w = await seedWallet();

    await svc.deposit({ userId: w.userId, amount: '10', currency: 'USD' });
    await svc.deposit({ userId: w.userId, amount: '10', currency: 'USD' });

    const rows = await txRows(w.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.idempotencyKey === null)).toBe(true);
    expect(await balanceOf(w.userId)).toBe(20);
  });

  it('never double-credits when two first attempts race on the same key', async () => {
    const { svc } = makeService();
    const w = await seedWallet();
    const idempotencyKey = randomUUID();

    await Promise.all([
      svc.deposit({ userId: w.userId, amount: '10', currency: 'USD', idempotencyKey }),
      svc.deposit({ userId: w.userId, amount: '10', currency: 'USD', idempotencyKey }),
    ]);

    expect(await txRows(w.id)).toHaveLength(1);
    expect(await balanceOf(w.userId)).toBe(10);
  });

  it('throws IdempotencyKeyReuseError when the key is replayed with a different currency', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ currency: 'USD' });
    const idempotencyKey = randomUUID();
    await svc.deposit({ userId: w.userId, amount: '10', currency: 'USD', idempotencyKey });

    await expect(
      svc.deposit({ userId: w.userId, amount: '10', currency: 'EUR', idempotencyKey }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });
});

describe('WalletService idempotency - withdraw (real PG)', () => {
  it('replays the stored transaction without a second hold or event', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ balance: '100' });
    const idempotencyKey = randomUUID();

    const first = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      idempotencyKey,
      ...NO_CLIENT_META,
    });
    const replay = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      idempotencyKey,
      ...NO_CLIENT_META,
    });

    expect(replay).toEqual(first);
    expect(await txRows(w.id)).toHaveLength(1);
    expect(await balanceOf(w.userId)).toBe(60);
    expect(emittedTopics(events)).toEqual(['wallet.withdrawal.requested']);
  });

  it('throws IdempotencyKeyReuseError when the key is replayed with a different amount', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100' });
    const idempotencyKey = randomUUID();
    await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      idempotencyKey,
      ...NO_CLIENT_META,
    });

    await expect(
      svc.withdraw({
        userId: w.userId,
        amount: '41',
        currency: 'USD',
        idempotencyKey,
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
    expect(await balanceOf(w.userId)).toBe(60);
  });

  it('distinct idempotency keys hold funds twice', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100' });

    await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      idempotencyKey: randomUUID(),
      ...NO_CLIENT_META,
    });
    await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      idempotencyKey: randomUUID(),
      ...NO_CLIENT_META,
    });

    expect(await txRows(w.id)).toHaveLength(2);
    expect(await balanceOf(w.userId)).toBe(20);
  });

  it('namespaces the key per operation so a deposit and a withdraw never collide', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '100' });
    const idempotencyKey = randomUUID();

    const deposited = await svc.deposit({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      idempotencyKey,
    });
    const withdrawn = await svc.withdraw({
      userId: w.userId,
      amount: '40',
      currency: 'USD',
      idempotencyKey,
      ...NO_CLIENT_META,
    });

    expect(deposited.transactionId).not.toBe(withdrawn.transactionId);
    const rows = await txRows(w.id);
    expect(rows.map((r) => r.type).sort()).toEqual(['deposit', 'withdrawal']);
    expect(new Set(rows.map((r) => r.idempotencyKey)).size).toBe(2);
    expect(await balanceOf(w.userId)).toBe(100);
  });
});

describe('WalletService.withdraw destination whitelisting (real PG)', () => {
  const whitelistingPsp = () => ({
    ...makePsp(),
    whitelistWithdrawalAddress: async () => ({ providerWalletId: 'fb-wallet-1' }),
  });

  it('refuses an unsaved payout address before any funds are held', async () => {
    const psp = whitelistingPsp();
    const { svc } = makeService({ payment: mock<PaymentAdapter>(psp) });
    const w = await seedWallet({ currency: 'BTC', balance: '5' });

    await expect(
      svc.withdraw({
        userId: w.userId,
        amount: '1',
        currency: 'BTC',
        network: 'BITCOIN',
        destinationAddress: 'bc1qnever-saved',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(DestinationAddressNotWhitelistedError);

    // The balance is untouched and there is no pending withdrawal for an operator to unwind.
    expect(await balanceOf(w.userId)).toBe(5);
    expect(psp.processWithdrawal).not.toHaveBeenCalled();
  });

  it('accepts an address that was whitelisted through the address book', async () => {
    const psp = whitelistingPsp();
    const { svc } = makeService({ payment: mock<PaymentAdapter>(psp) });
    const w = await seedWallet({ currency: 'BTC', balance: '5' });
    await db.drizzle.db.insert(walletWithdrawalAddress).values({
      userId: w.userId,
      label: 'cold',
      currency: 'BTC',
      network: 'BITCOIN',
      address: 'bc1qsaved',
      providerName: DEFAULT_PAYMENT_PROVIDER,
      providerWalletId: 'fb-wallet-1',
    });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      network: 'BITCOIN',
      destinationAddress: 'bc1qsaved',
      ...NO_CLIENT_META,
    });

    expect(result.transactionId).toBeDefined();
  });

  it('refuses a tag the player never whitelisted on an address they did', async () => {
    const psp = whitelistingPsp();
    const { svc } = makeService({ payment: mock<PaymentAdapter>(psp) });
    const w = await seedWallet({ currency: 'XRP', balance: '5' });
    await db.drizzle.db.insert(walletWithdrawalAddress).values({
      userId: w.userId,
      label: 'my exchange account',
      currency: 'XRP',
      network: 'XRPL',
      address: 'rSharedExchangeAddress',
      destinationTag: '1000',
      providerName: DEFAULT_PAYMENT_PROVIDER,
      providerWalletId: 'fb-wallet-1',
    });

    // Same shared exchange address, someone else's account behind it.
    await expect(
      svc.withdraw({
        userId: w.userId,
        amount: '1',
        currency: 'XRP',
        network: 'XRPL',
        destinationAddress: 'rSharedExchangeAddress',
        destinationTag: '2000',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(DestinationAddressNotWhitelistedError);

    // Dropping the tag must not fall back to the address-only match either.
    await expect(
      svc.withdraw({
        userId: w.userId,
        amount: '1',
        currency: 'XRP',
        network: 'XRPL',
        destinationAddress: 'rSharedExchangeAddress',
        ...NO_CLIENT_META,
      }),
    ).rejects.toBeInstanceOf(DestinationAddressNotWhitelistedError);

    expect(await balanceOf(w.userId)).toBe(5);
    expect(psp.processWithdrawal).not.toHaveBeenCalled();

    const allowed = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'XRP',
      network: 'XRPL',
      destinationAddress: 'rSharedExchangeAddress',
      destinationTag: '1000',
      ...NO_CLIENT_META,
    });
    expect(allowed.transactionId).toBeDefined();
  });

  it('carries the destination tag through to the payout adapter', async () => {
    const { svc, psp } = makeService();
    const w = await seedWallet({ currency: 'BTC', balance: '5' });

    const requested = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      network: 'BITCOIN',
      destinationAddress: 'bc1qexample',
      destinationTag: '4138454749',
      ...NO_CLIENT_META,
    });
    await svc.approveWithdrawal(randomUUID(), requested.transactionId, NO_CLIENT_META);

    expect(psp.processWithdrawal).toHaveBeenCalledWith(
      expect.any(String),
      'BTC',
      expect.objectContaining({ destinationTag: '4138454749' }),
    );
  });

  it('leaves the tag null for a payout that carries none', async () => {
    const { svc, psp } = makeService();
    const w = await seedWallet({ currency: 'BTC', balance: '5' });

    const requested = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      network: 'BITCOIN',
      destinationAddress: 'bc1qexample',
      ...NO_CLIENT_META,
    });
    await svc.approveWithdrawal(randomUUID(), requested.transactionId, NO_CLIENT_META);

    expect(psp.processWithdrawal).toHaveBeenCalledWith(
      expect.any(String),
      'BTC',
      expect.objectContaining({ destinationTag: null }),
    );
  });

  it('leaves a non-whitelisting adapter alone', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ currency: 'BTC', balance: '5' });

    const result = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      network: 'BITCOIN',
      destinationAddress: 'bc1qnever-saved',
      ...NO_CLIENT_META,
    });

    expect(result.transactionId).toBeDefined();
  });
});

describe('WalletService.approveWithdrawal (real PG)', () => {
  it('moves pending -> completed and emits approved then completed', async () => {
    const { svc, events, psp } = makeService();
    const w = await seedWallet({ balance: '60' });
    const adminId = randomUUID();
    const pending = await seedTx(w.id, { amount: '40' });

    const result = await svc.approveWithdrawal(adminId, pending.id, NO_CLIENT_META);

    expect(result).toEqual({ transactionId: pending.id, status: 'completed' });
    expect(psp.processWithdrawal).toHaveBeenCalledTimes(1);
    expect(await txById(pending.id)).toMatchObject({
      status: 'completed',
      reviewedBy: adminId,
      providerName: DEFAULT_PAYMENT_PROVIDER,
    });
    expect(await balanceOf(w.userId)).toBe(60);
    expect(emittedTopics(events)).toEqual([
      'wallet.withdrawal.approved',
      'wallet.withdrawal.completed',
    ]);
  });

  it('sends the whitelisted wallet id pinned on the withdrawal at request time', async () => {
    const psp = {
      ...makePsp(),
      whitelistWithdrawalAddress: async () => ({ providerWalletId: 'fb-wallet-1' }),
    };
    const { svc } = makeService({ payment: mock<PaymentAdapter>(psp) });
    const w = await seedWallet({ currency: 'BTC', balance: '5' });
    await db.drizzle.db.insert(walletWithdrawalAddress).values({
      userId: w.userId,
      label: 'cold',
      currency: 'BTC',
      network: 'BITCOIN',
      address: 'bc1qsaved',
      providerName: DEFAULT_PAYMENT_PROVIDER,
      providerWalletId: 'fb-wallet-1',
    });

    const requested = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qsaved',
      ...NO_CLIENT_META,
    });
    await svc.approveWithdrawal(randomUUID(), requested.transactionId);

    expect(psp.processWithdrawal).toHaveBeenCalledWith(
      expect.any(String),
      'BTC',
      expect.objectContaining({ destinationWalletId: 'fb-wallet-1' }),
    );
  });

  it('still pays out a pending withdrawal whose saved address was deleted meanwhile', async () => {
    const psp = {
      ...makePsp(),
      whitelistWithdrawalAddress: async () => ({ providerWalletId: 'fb-wallet-1' }),
    };
    const { svc } = makeService({ payment: mock<PaymentAdapter>(psp) });
    const w = await seedWallet({ currency: 'BTC', balance: '5' });
    const [saved] = await db.drizzle.db
      .insert(walletWithdrawalAddress)
      .values({
        userId: w.userId,
        label: 'cold',
        currency: 'BTC',
        network: 'BITCOIN',
        address: 'bc1qsaved',
        providerName: DEFAULT_PAYMENT_PROVIDER,
        providerWalletId: 'fb-wallet-1',
      })
      .returning();

    const requested = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qsaved',
      ...NO_CLIENT_META,
    });
    await svc.deleteWithdrawalAddress(w.userId, saved!.id);
    await svc.approveWithdrawal(randomUUID(), requested.transactionId);

    expect(psp.processWithdrawal).toHaveBeenCalledWith(
      expect.any(String),
      'BTC',
      expect.objectContaining({ destinationWalletId: 'fb-wallet-1' }),
    );
  });

  it('re-registers a saved address that predates the whitelisting adapter', async () => {
    const whitelistWithdrawalAddress = vi.fn(async () => ({ providerWalletId: 'fb-wallet-9' }));
    const psp = { ...makePsp(), whitelistWithdrawalAddress };
    const { svc } = makeService({ payment: mock<PaymentAdapter>(psp) });
    const w = await seedWallet({ currency: 'BTC', balance: '5' });
    await db.drizzle.db.insert(walletWithdrawalAddress).values({
      userId: w.userId,
      label: 'legacy',
      currency: 'BTC',
      network: 'BITCOIN',
      address: 'bc1qlegacy',
    });

    const requested = await svc.withdraw({
      userId: w.userId,
      amount: '1',
      currency: 'BTC',
      destinationAddress: 'bc1qlegacy',
      ...NO_CLIENT_META,
    });
    await svc.approveWithdrawal(randomUUID(), requested.transactionId);

    expect(whitelistWithdrawalAddress).toHaveBeenCalledTimes(1);
    expect(psp.processWithdrawal).toHaveBeenCalledWith(
      expect.any(String),
      'BTC',
      expect.objectContaining({ destinationWalletId: 'fb-wallet-9' }),
    );
  });

  // Defence in depth: withdraw() already rejects an unsaved address, so this only reaches
  // approval for a row seeded around it - but the payout must still not invent a destination.
  it('sends no wallet id for an address that was never whitelisted', async () => {
    const psp = {
      ...makePsp(),
      whitelistWithdrawalAddress: async () => ({ providerWalletId: 'fb-wallet-1' }),
    };
    const { svc } = makeService({ payment: mock<PaymentAdapter>(psp) });
    const w = await seedWallet({ currency: 'BTC' });
    const pending = await seedTx(w.id, {
      currency: 'BTC',
      rail: 'crypto',
      amount: '1',
      network: 'BITCOIN',
      destinationAddress: 'bc1qnever-saved',
    });

    await svc.approveWithdrawal(randomUUID(), pending.id);

    expect(psp.processWithdrawal).toHaveBeenCalledWith(
      expect.any(String),
      'BTC',
      expect.not.objectContaining({ destinationWalletId: expect.anything() }),
    );
  });

  it('resolves providerName from the default binding when the pair has no catalog row', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ currency: 'BTC' });
    const pending = await seedTx(w.id, { currency: 'BTC', rail: 'crypto', amount: '1' });

    await svc.approveWithdrawal(randomUUID(), pending.id);

    expect(await txById(pending.id)).toMatchObject({ providerName: DEFAULT_PAYMENT_PROVIDER });
  });

  it("resolves providerName from the (currency, network) catalog row's own providerName", async () => {
    const { svc } = makeService();
    await db.drizzle.db.insert(walletAsset).values({
      currency: 'USDT',
      network: 'ERC20',
      providerAssetId: 'USDT_ERC20',
      minDeposit: '1',
      minWithdrawal: '1',
      withdrawalFee: '1',
      providerName: 'vendor-a',
    });
    const w = await seedWallet({ currency: 'USDT' });
    const pending = await seedTx(w.id, {
      currency: 'USDT',
      network: 'ERC20',
      rail: 'crypto',
      amount: '5',
    });

    await svc.approveWithdrawal(randomUUID(), pending.id);

    expect(await txById(pending.id)).toMatchObject({ providerName: 'vendor-a' });
  });

  it('falls back to the default binding when the catalog row has a null providerName', async () => {
    const { svc } = makeService();
    await db.drizzle.db.insert(walletAsset).values({
      currency: 'USDT',
      network: 'TRC20',
      providerAssetId: 'USDT_TRC20',
      minDeposit: '1',
      minWithdrawal: '1',
      withdrawalFee: '1',
    });
    const w = await seedWallet({ currency: 'USDT' });
    const pending = await seedTx(w.id, {
      currency: 'USDT',
      network: 'TRC20',
      rail: 'crypto',
      amount: '5',
    });

    await svc.approveWithdrawal(randomUUID(), pending.id);

    expect(await txById(pending.id)).toMatchObject({ providerName: DEFAULT_PAYMENT_PROVIDER });
  });

  it('marks failed, refunds the hold, emits failed, and rethrows when the PSP throws', async () => {
    const { svc, events, psp } = makeService();
    const w = await seedWallet({ balance: '20' });
    const pending = await seedTx(w.id, { amount: '40' });
    psp.processWithdrawal.mockRejectedValueOnce(new Error('psp down'));

    await expect(svc.approveWithdrawal(randomUUID(), pending.id)).rejects.toThrow('psp down');

    expect(await txById(pending.id)).toMatchObject({ status: 'failed' });
    expect(await balanceOf(w.userId)).toBe(60);
    expect(emittedTopics(events)).toEqual([
      'wallet.withdrawal.approved',
      'wallet.withdrawal.failed',
    ]);
  });

  it('marks failed and refunds when the PSP answers with a failed status', async () => {
    const { svc, psp } = makeService();
    const w = await seedWallet({ balance: '20' });
    const pending = await seedTx(w.id, { amount: '40' });
    psp.processWithdrawal.mockResolvedValueOnce({ externalId: randomUUID(), status: 'failed' });

    const result = await svc.approveWithdrawal(randomUUID(), pending.id);

    expect(result.status).toBe('failed');
    expect(await balanceOf(w.userId)).toBe(60);
  });

  it('leaves the row processing when an async vendor returns a non-terminal status', async () => {
    const { svc, events, psp } = makeService();
    const w = await seedWallet({ balance: '20' });
    const pending = await seedTx(w.id, { amount: '40' });
    const externalId = randomUUID();
    psp.processWithdrawal.mockResolvedValueOnce({ externalId, status: 'processing' });

    const result = await svc.approveWithdrawal(randomUUID(), pending.id);

    expect(result.status).toBe('processing');
    expect(await txById(pending.id)).toMatchObject({
      status: 'processing',
      providerRefId: externalId,
    });
    expect(await balanceOf(w.userId)).toBe(20);
    expect(emittedTopics(events)).toEqual(['wallet.withdrawal.approved']);
  });

  it('rejects a double approve as a conflict', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '60' });
    const pending = await seedTx(w.id, { amount: '40' });
    await svc.approveWithdrawal(randomUUID(), pending.id);

    await expect(svc.approveWithdrawal(randomUUID(), pending.id)).rejects.toBeInstanceOf(
      WithdrawalNotPendingError,
    );
  });

  it('throws WithdrawalNotFoundError when the id is unknown', async () => {
    const { svc } = makeService();

    await expect(svc.approveWithdrawal(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      WithdrawalNotFoundError,
    );
  });
});

describe('WalletService.rejectWithdrawal (real PG)', () => {
  it('returns the held funds, records the reason, and emits rejected', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ balance: '20' });
    const adminId = randomUUID();
    const pending = await seedTx(w.id, { amount: '40' });

    const result = await svc.rejectWithdrawal(adminId, pending.id, 'suspicious', NO_CLIENT_META);

    expect(result).toEqual({ transactionId: pending.id, status: 'rejected' });
    expect(await balanceOf(w.userId)).toBe(60);
    expect(await txById(pending.id)).toMatchObject({
      status: 'rejected',
      reviewedBy: adminId,
      reviewReason: 'suspicious',
    });
    expect(events.emit).toHaveBeenCalledWith(
      'wallet.withdrawal.rejected',
      expect.objectContaining({ userId: w.userId, reason: 'suspicious', adminId }),
    );
  });

  it('rejects a double reject as a conflict', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ balance: '20' });
    const pending = await seedTx(w.id, { amount: '40' });
    await svc.rejectWithdrawal(randomUUID(), pending.id, 'first');

    await expect(svc.rejectWithdrawal(randomUUID(), pending.id, 'second')).rejects.toBeInstanceOf(
      WithdrawalNotPendingError,
    );
    expect(await balanceOf(w.userId)).toBe(60);
  });
});

describe('WalletService.listWithdrawals (real PG)', () => {
  it('enriches rows with username, kycStatus, and playerId from the directory port', async () => {
    const w = await seedWallet();
    const playerId = randomUUID();
    const directory = makeDirectory([
      {
        playerId,
        userId: w.userId,
        username: 'player1',
        kycStatus: 'verified',
      } as AdminPlayerSummary,
    ]);
    const { svc } = makeService({ directory });
    await seedTx(w.id, { amount: '10' });

    const { items, total } = await svc.listWithdrawals({ page: 1, limit: 20 });

    expect(total).toBe(1);
    expect(items[0]).toMatchObject({
      userId: w.userId,
      playerId,
      username: 'player1',
      kycStatus: 'verified',
      riskTags: [],
    });
    expect(() => WithdrawalQueueItemSchema.parse(items[0])).not.toThrow();
  });

  it('yields playerId: null when the user has no player summary', async () => {
    const w = await seedWallet();
    const directory = makeDirectory([]);
    const { svc } = makeService({ directory });
    await seedTx(w.id, { amount: '10' });

    const { items } = await svc.listWithdrawals({ page: 1, limit: 20 });

    expect(items[0]).toMatchObject({ userId: w.userId, playerId: null, username: '' });
  });

  it('returns rows of every status when no status filter is given', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { status: 'pending' });
    await seedTx(w.id, { status: 'completed' });
    await seedTx(w.id, { status: 'rejected' });

    const { items } = await queueService().listWithdrawals({ page: 1, limit: 20 });

    expect(items.map((i) => i.status).sort()).toEqual(['completed', 'pending', 'rejected']);
  });

  it('excludes deposits from the withdrawal queue', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { type: 'deposit', status: 'completed' });
    await seedTx(w.id, { type: 'withdrawal' });

    const { total } = await queueService().listWithdrawals({ page: 1, limit: 20 });

    expect(total).toBe(1);
  });

  it('applies the kycStatus filter to the total, not just the page', async () => {
    const verified = await seedWallet();
    const pendingKyc = await seedWallet();
    await seedTx(verified.id);
    await seedTx(pendingKyc.id);
    const directory = makeDirectory([
      { userId: verified.userId, username: 'a', kycStatus: 'verified' } as AdminPlayerSummary,
      { userId: pendingKyc.userId, username: 'b', kycStatus: 'pending' } as AdminPlayerSummary,
    ]);
    const { svc } = makeService({ directory });

    const { items, total } = await svc.listWithdrawals({
      page: 1,
      limit: 20,
      kycStatus: 'verified',
    });

    expect(total).toBe(1);
    expect(items[0]?.userId).toBe(verified.userId);
  });

  it('matches a legacy directory-reported "verified" when filtering by the canonical "approved"', async () => {
    const legacyVerified = await seedWallet();
    const pendingKyc = await seedWallet();
    await seedTx(legacyVerified.id);
    await seedTx(pendingKyc.id);
    const directory = makeDirectory([
      { userId: legacyVerified.userId, username: 'a', kycStatus: 'verified' } as AdminPlayerSummary,
      { userId: pendingKyc.userId, username: 'b', kycStatus: 'pending' } as AdminPlayerSummary,
    ]);
    const { svc } = makeService({ directory });

    const { items, total } = await svc.listWithdrawals({
      page: 1,
      limit: 20,
      kycStatus: 'approved',
    });

    expect(total).toBe(1);
    expect(items[0]?.userId).toBe(legacyVerified.userId);
  });

  it('slices the requested page out of the filtered set', async () => {
    const w = await seedWallet();
    await seedTx(w.id, { createdAt: new Date('2026-01-01T00:00:00.000Z') });
    await seedTx(w.id, { createdAt: new Date('2026-01-02T00:00:00.000Z') });
    await seedTx(w.id, { createdAt: new Date('2026-01-03T00:00:00.000Z') });

    const { items, total } = await queueService().listWithdrawals({ page: 2, limit: 2 });

    expect(total).toBe(3);
    expect(items).toHaveLength(1);
  });

  it('tags large_amount at or above the threshold, not below it', async () => {
    const w = await seedWallet();
    const big = await seedTx(w.id, { amount: '5000' });
    const small = await seedTx(w.id, { amount: '4999.99' });

    const { items } = await queueService().listWithdrawals({ page: 1, limit: 20 });

    const byId = new Map(items.map((i) => [i.transactionId, i.riskTags]));
    expect(byId.get(big.id)).toContain('large_amount');
    expect(byId.get(small.id)).not.toContain('large_amount');
  });

  it('tags high_frequency once the wallet has three withdrawals in the trailing 24h', async () => {
    const quiet = await seedWallet();
    const busy = await seedWallet();
    await seedTx(quiet.id);
    await seedTx(busy.id);
    await seedTx(busy.id);
    await seedTx(busy.id);

    const { items } = await queueService().listWithdrawals({ page: 1, limit: 20 });

    const busyItem = items.find((i) => i.userId === busy.userId);
    const quietItem = items.find((i) => i.userId === quiet.userId);
    expect(busyItem?.riskTags).toContain('high_frequency');
    expect(quietItem?.riskTags).not.toContain('high_frequency');
  });

  it('ignores withdrawals older than the velocity window', async () => {
    const w = await seedWallet();
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await seedTx(w.id, { createdAt: old });
    await seedTx(w.id, { createdAt: old });
    await seedTx(w.id);

    const { items } = await queueService().listWithdrawals({ page: 1, limit: 20 });

    expect(items.every((i) => !i.riskTags.includes('high_frequency'))).toBe(true);
  });
});

describe('WalletService.reconcileWithdrawalStatus (real PG)', () => {
  it('transitions processing -> completed and emits completed', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet();
    const externalId = randomUUID();
    const tx = await seedTx(w.id, { status: 'processing', providerRefId: externalId });

    await svc.reconcileWithdrawalStatus({
      kind: 'withdrawal',
      externalId,
      status: 'completed',
      txHash: '0xabc',
    });

    expect(await txById(tx.id)).toMatchObject({ status: 'completed', txHash: '0xabc' });
    expect(emittedTopics(events)).toEqual(['wallet.withdrawal.completed']);
  });

  it('refunds and marks failed without an admin-attributed event', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ balance: '0' });
    const externalId = randomUUID();
    const tx = await seedTx(w.id, {
      status: 'processing',
      amount: '40',
      providerRefId: externalId,
    });

    await svc.reconcileWithdrawalStatus({ kind: 'withdrawal', externalId, status: 'failed' });

    expect(await txById(tx.id)).toMatchObject({ status: 'failed' });
    expect(await balanceOf(w.userId)).toBe(40);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('no-ops on a replay of an already terminal transaction', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ balance: '0' });
    const externalId = randomUUID();
    const tx = await seedTx(w.id, { status: 'completed', amount: '40', providerRefId: externalId });

    await svc.reconcileWithdrawalStatus({ kind: 'withdrawal', externalId, status: 'failed' });

    expect(await txById(tx.id)).toMatchObject({ status: 'completed' });
    expect(await balanceOf(w.userId)).toBe(0);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('no-ops when no transaction carries the providerRefId', async () => {
    const { svc, events } = makeService();

    await svc.reconcileWithdrawalStatus({
      kind: 'withdrawal',
      externalId: randomUUID(),
      status: 'completed',
    });

    expect(events.emit).not.toHaveBeenCalled();
  });
});

describe('WalletService.getOrCreateDepositAddress (real PG)', () => {
  it('returns the already-issued address without calling the adapter again', async () => {
    const userId = randomUUID();
    const issueDepositAddress = vi.fn();
    const { svc } = makeService({
      payment: mock<PaymentAdapter>({ ...makePsp(), issueDepositAddress }),
    });
    await db.drizzle.db.insert(walletDepositAddress).values({
      userId,
      currency: 'BTC',
      address: 'bc1qexisting',
      providerName: 'custody',
    });

    expect(await svc.getOrCreateDepositAddress(userId, 'BTC')).toEqual({
      address: 'bc1qexisting',
      currency: 'BTC',
    });
    expect(issueDepositAddress).not.toHaveBeenCalled();
  });

  it('issues and persists a new address on the first call', async () => {
    const userId = randomUUID();
    const issueDepositAddress = vi.fn(async () => ({ address: 'bc1qnew' }));
    const { svc } = makeService({
      payment: mock<PaymentAdapter>({ ...makePsp(), issueDepositAddress }),
    });

    const result = await svc.getOrCreateDepositAddress(userId, 'BTC');

    expect(result).toEqual({ address: 'bc1qnew', currency: 'BTC' });
    const [stored] = await db.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, userId));
    expect(stored).toMatchObject({ address: 'bc1qnew', providerName: DEFAULT_PAYMENT_PROVIDER });
  });

  it("persists the (currency, network) catalog row's own providerName", async () => {
    await db.drizzle.db.insert(walletAsset).values({
      currency: 'USDT',
      network: 'ERC20',
      providerAssetId: 'USDT_ERC20',
      minDeposit: '1',
      minWithdrawal: '1',
      withdrawalFee: '1',
      providerName: 'vendor-a',
    });
    const userId = randomUUID();
    const issueDepositAddress = vi.fn(async () => ({ address: '0xnew' }));
    const { svc } = makeService({
      payment: mock<PaymentAdapter>({ ...makePsp(), issueDepositAddress }),
    });

    await svc.getOrCreateDepositAddress(userId, 'USDT', 'ERC20');

    const [stored] = await db.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, userId));
    expect(stored).toMatchObject({ address: '0xnew', providerName: 'vendor-a' });
  });

  it('issues one address when two calls race on the same user and currency', async () => {
    const userId = randomUUID();
    const issueDepositAddress = vi.fn(async () => ({ address: 'bc1qrace' }));
    const { svc } = makeService({
      payment: mock<PaymentAdapter>({ ...makePsp(), issueDepositAddress }),
    });

    const [a, b] = await Promise.all([
      svc.getOrCreateDepositAddress(userId, 'BTC'),
      svc.getOrCreateDepositAddress(userId, 'BTC'),
    ]);

    expect(a).toEqual(b);
    const stored = await db.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, userId));
    expect(stored).toHaveLength(1);
  });

  it('throws DepositAddressUnsupportedError when the adapter cannot issue addresses', async () => {
    const { svc } = makeService();

    await expect(svc.getOrCreateDepositAddress(randomUUID(), 'BTC')).rejects.toBeInstanceOf(
      DepositAddressUnsupportedError,
    );
  });
});

describe('WalletService.creditDepositByAddress (real PG)', () => {
  async function seedAddress(userId: string, address: string, currency = 'BTC', network?: string) {
    await db.drizzle.db
      .insert(walletDepositAddress)
      .values({ userId, currency, address, network, providerName: 'custody' });
  }

  it('resolves the address, credits the wallet, and emits deposit.completed', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ currency: 'BTC', balance: '1' });
    await seedAddress(w.userId, 'bc1qcredit');

    await svc.creditDepositByAddress({
      kind: 'deposit',
      address: 'bc1qcredit',
      amount: '0.5',
      currency: 'BTC',
      externalId: randomUUID(),
      txHash: '0xdead',
    });

    expect(await balanceOf(w.userId)).toBe(1.5);
    expect(emittedTopics(events)).toEqual(['wallet.deposit.completed']);
  });

  it('credits nobody and files an unattributed_deposit finding when the address is unknown', async () => {
    const { svc, events } = makeService();
    const externalId = randomUUID();

    await svc.creditDepositByAddress(
      {
        kind: 'deposit',
        address: 'bc1qunknown',
        amount: '1',
        currency: 'BTC',
        externalId,
        txHash: '0xunknown',
      },
      'default',
    );

    expect(events.emit).not.toHaveBeenCalled();
    const findings = await db.drizzle.db
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.externalId, externalId));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'unattributed_deposit',
      providerName: 'default',
      status: 'open',
    });
  });

  it('is idempotent on a replayed externalId', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ currency: 'BTC', balance: '0' });
    await seedAddress(w.userId, 'bc1qreplay');
    const externalId = randomUUID();
    const event = {
      kind: 'deposit' as const,
      address: 'bc1qreplay',
      amount: '2',
      currency: 'BTC',
      externalId,
      txHash: '0xreplay',
    };

    await svc.creditDepositByAddress(event);
    await svc.creditDepositByAddress(event);

    expect(await balanceOf(w.userId)).toBe(2);
    expect(await txRows(w.id)).toHaveLength(1);
    expect(emittedTopics(events)).toEqual(['wallet.deposit.completed']);
  });

  it('credits nobody and files a currency_mismatch finding on a currency mismatch', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet({ currency: 'BTC' });
    await seedAddress(w.userId, 'bc1qmismatch');
    const externalId = randomUUID();

    await svc.creditDepositByAddress({
      kind: 'deposit',
      address: 'bc1qmismatch',
      amount: '1',
      currency: 'ETH',
      externalId,
      txHash: '0xmismatch',
    });

    expect(events.emit).not.toHaveBeenCalled();
    expect(await balanceOf(w.userId)).toBe(0);
    const findings = await db.drizzle.db
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.externalId, externalId));
    expect(findings).toHaveLength(1);
    // Its own taxonomy, not `unattributed_deposit`: the address resolved fine, the
    // currency did not. The polled path already tags this case `currency_mismatch`,
    // and an admin filtering findings by kind has to see both paths alike.
    expect(findings[0]).toMatchObject({ kind: 'currency_mismatch', status: 'open' });
  });

  it('credits a token that shares the EVM address issued for another currency', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ currency: 'ETH', balance: '0' });
    await seedAddress(w.userId, '0xshared', 'ETH', 'ERC20');

    await svc.creditDepositByAddress({
      kind: 'deposit',
      address: '0xshared',
      network: 'ERC20',
      amount: '25',
      currency: 'USDT',
      externalId: randomUUID(),
      txHash: '0xtoken',
    });

    expect(await balanceOf(w.userId, 'USDT')).toBe(25);
  });

  it('picks the row matching the event network when one address serves two chains', async () => {
    const { svc } = makeService();
    const w = await seedWallet({ currency: 'ETH', balance: '0' });
    await seedAddress(w.userId, '0xmultichain', 'USDT', 'ERC20');
    await seedAddress(w.userId, '0xmultichain', 'USDT', 'BEP20');

    await svc.creditDepositByAddress({
      kind: 'deposit',
      address: '0xmultichain',
      network: 'BEP20',
      amount: '10',
      currency: 'USDT',
      externalId: randomUUID(),
      txHash: '0xbsc',
    });

    expect(await balanceOf(w.userId, 'USDT')).toBe(10);
  });

  it('refuses to credit an address issued to more than one user', async () => {
    const { svc } = makeService();
    const first = await seedWallet({ currency: 'ETH', balance: '0' });
    const second = await seedWallet({ currency: 'ETH', balance: '0' });
    await seedAddress(first.userId, '0xcollision', 'ETH', 'ERC20');
    await seedAddress(second.userId, '0xcollision', 'USDT', 'ERC20');

    await expect(
      svc.creditDepositByAddress({
        kind: 'deposit',
        address: '0xcollision',
        network: 'ERC20',
        amount: '1',
        currency: 'ETH',
        externalId: randomUUID(),
        txHash: '0xcollide',
      }),
    ).rejects.toBeInstanceOf(AmbiguousDepositAddressError);
  });
});
