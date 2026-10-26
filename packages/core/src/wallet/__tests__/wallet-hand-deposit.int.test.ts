import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { DepositHoldPolicy, PaymentAdapter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  makeAuditWriter,
  makeExchangeRateReader,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletDepositAddress,
  walletReconciliationFinding,
  walletTransaction,
} from '../schema/index.js';
import {
  DepositAlreadyOnLedgerError,
  DepositStillHeldError,
  HeldDepositNotFoundError,
  PlayerNotFoundError,
  WalletService,
  type HandDeposit,
} from '../service/wallet.service.js';

let db: TestDb;

const holdPolicy = (reason: string | null): DepositHoldPolicy => ({
  holdReason: vi.fn(async () => reason),
});

function makeService({
  depositHold,
  knownPlayer = true,
}: { depositHold?: DepositHoldPolicy; knownPlayer?: boolean } = {}) {
  const events = makeEventBus();
  const identityReader = makeIdentityReader();
  const playerId = knownPlayer ? randomUUID() : null;
  vi.mocked(identityReader.getPlayerIdByUserId).mockResolvedValue(playerId);
  vi.mocked(identityReader.getPlayerIdByUserIdSafe).mockResolvedValue(playerId);
  const svc = new WalletService({
    drizzle: db.drizzle,
    events,
    payment: mock<PaymentAdapter>({}),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader,
    rates: makeExchangeRateReader(),
    ...(depositHold ? { depositHold } : {}),
  });
  return { svc, events, playerId };
}

async function seedWallet(balance = '0', currency = 'BTC') {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedWallet: no row'),
  );
  await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency, amount: balance });
  return row;
}

const seedDeposit = async (
  walletId: string,
  overrides: Partial<typeof walletTransaction.$inferInsert> = {},
) =>
  findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'deposit',
        amount: '2',
        currency: 'BTC',
        status: 'on_hold',
        direction: 'credit',
        rail: 'crypto',
        ...overrides,
      })
      .returning(),
    new Error('seedDeposit: no row'),
  );

async function balanceOf(userId: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(eq(wallet.userId, userId));
  return Number(row?.amount ?? 0);
}

const handDeposit = (userId: string, overrides: Partial<HandDeposit> = {}): HandDeposit => ({
  userId,
  adminId: randomUUID(),
  amount: '2',
  currency: 'BTC',
  network: null,
  providerName: 'custody',
  providerRefId: randomUUID(),
  address: 'bc1qhand',
  tag: null,
  txHash: '0xhand',
  ...overrides,
});

const inTxn = <T>(fn: Parameters<typeof db.drizzle.db.transaction<T>>[0]) =>
  db.drizzle.db.transaction(fn);

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletDepositAddress}, ${walletReconciliationFinding}, ${walletBalance}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

describe('WalletService.releaseHeldDeposit (real PG)', () => {
  it('credits a held deposit once the policy lets it through, stamping the admin', async () => {
    const { svc } = makeService({ depositHold: holdPolicy(null) });
    const w = await seedWallet('1');
    const held = await seedDeposit(w.id, { amount: '2' });
    const adminId = randomUUID();

    const released = await inTxn((txn) => svc.releaseHeldDeposit(txn, held.id, adminId));

    expect(released).toEqual({ userId: w.userId, amount: '2.000000000000000000', currency: 'BTC' });
    expect(await balanceOf(w.userId)).toBe(3);
    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, held.id));
    expect(row).toMatchObject({ status: 'completed', reviewedBy: adminId });
    expect(row?.reviewedAt).toBeInstanceOf(Date);
  });

  it('does not credit twice when released again', async () => {
    const { svc } = makeService({ depositHold: holdPolicy(null) });
    const w = await seedWallet('0');
    const held = await seedDeposit(w.id);
    await inTxn((txn) => svc.releaseHeldDeposit(txn, held.id, randomUUID()));

    await expect(
      inTxn((txn) => svc.releaseHeldDeposit(txn, held.id, randomUUID())),
    ).rejects.toBeInstanceOf(HeldDepositNotFoundError);
    expect(await balanceOf(w.userId)).toBe(2);
  });

  it('refuses anything that is not a held deposit', async () => {
    const { svc } = makeService({ depositHold: holdPolicy(null) });
    const w = await seedWallet('0');
    const completed = await seedDeposit(w.id, { status: 'completed' });
    const heldWithdrawal = await seedDeposit(w.id, { type: 'withdrawal', direction: 'debit' });

    for (const id of [randomUUID(), completed.id, heldWithdrawal.id]) {
      await expect(
        inTxn((txn) => svc.releaseHeldDeposit(txn, id, randomUUID())),
      ).rejects.toBeInstanceOf(HeldDepositNotFoundError);
    }
    expect(await balanceOf(w.userId)).toBe(0);
  });

  it('keeps the deposit held and uncredited while the policy still holds it', async () => {
    const { svc } = makeService({ depositHold: holdPolicy('self_excluded') });
    const w = await seedWallet('0');
    const held = await seedDeposit(w.id);

    await expect(
      inTxn((txn) => svc.releaseHeldDeposit(txn, held.id, randomUUID())),
    ).rejects.toThrow(DepositStillHeldError);
    expect(await balanceOf(w.userId)).toBe(0);
    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, held.id));
    expect(row?.status).toBe('on_hold');
  });

  it('fails closed when no hold policy is bound to re-check it', async () => {
    const { svc } = makeService();
    const w = await seedWallet('0');
    const held = await seedDeposit(w.id);

    await expect(
      inTxn((txn) => svc.releaseHeldDeposit(txn, held.id, randomUUID())),
    ).rejects.toBeInstanceOf(DepositStillHeldError);
    expect(await balanceOf(w.userId)).toBe(0);
  });
});

describe('WalletService.creditDepositByHand (real PG)', () => {
  it('records a completed deposit keyed on the vendor id and credits the wallet, opening it when new', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const deposit = handDeposit(userId, { amount: '1.5', network: 'BITCOIN' });

    const result = await inTxn((txn) => svc.creditDepositByHand(txn, deposit));

    expect(result).toMatchObject({ userId, amount: '1.5', currency: 'BTC' });
    expect(await balanceOf(userId)).toBe(1.5);
    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, result.transactionId));
    expect(row).toMatchObject({
      type: 'deposit',
      status: 'completed',
      direction: 'credit',
      rail: 'crypto',
      network: 'BITCOIN',
      providerName: 'custody',
      providerRefId: deposit.providerRefId,
      destinationAddress: 'bc1qhand',
      txHash: '0xhand',
      reviewedBy: deposit.adminId,
    });
  });

  it('refuses an unknown player and writes nothing', async () => {
    const { svc } = makeService({ knownPlayer: false });
    const userId = randomUUID();

    await expect(
      inTxn((txn) => svc.creditDepositByHand(txn, handDeposit(userId))),
    ).rejects.toBeInstanceOf(PlayerNotFoundError);
    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(0);
    expect(await db.drizzle.db.select().from(wallet)).toHaveLength(0);
  });

  it('refuses a deposit the policy would hold, before anything is written', async () => {
    const { svc } = makeService({ depositHold: holdPolicy('deposit_limit_exceeded') });
    const userId = randomUUID();

    await expect(
      inTxn((txn) => svc.creditDepositByHand(txn, handDeposit(userId))),
    ).rejects.toBeInstanceOf(DepositStillHeldError);
    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(0);
    expect(await db.drizzle.db.select().from(wallet)).toHaveLength(0);
  });

  it('refuses a vendor id already on the ledger and credits only once', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    const deposit = handDeposit(userId);
    await inTxn((txn) => svc.creditDepositByHand(txn, deposit));

    await expect(inTxn((txn) => svc.creditDepositByHand(txn, deposit))).rejects.toBeInstanceOf(
      DepositAlreadyOnLedgerError,
    );
    expect(await balanceOf(userId)).toBe(2);
    expect(await db.drizzle.db.select().from(walletTransaction)).toHaveLength(1);
  });
});

describe('WalletService.recordRefundedDeposit and webhook redelivery (real PG)', () => {
  const redelivery = (address: string, externalId: string) => ({
    kind: 'deposit' as const,
    address,
    amount: '2',
    currency: 'BTC',
    externalId,
    txHash: '0xhand',
  });

  it('records a terminal refunded row, moves no balance, and refuses the same vendor id twice', async () => {
    const { svc } = makeService();
    const w = await seedWallet('5');
    const deposit = handDeposit(w.userId, { providerRefId: 'refund-1' });

    const id = await inTxn((txn) =>
      svc.recordRefundedDeposit(txn, { ...deposit, providerRefId: 'refund-1' }),
    );

    const [row] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, id));
    expect(row).toMatchObject({ status: 'refunded', type: 'deposit', providerRefId: 'refund-1' });
    expect(await balanceOf(w.userId)).toBe(5);
    await expect(
      inTxn((txn) => svc.recordRefundedDeposit(txn, { ...deposit, providerRefId: 'refund-1' })),
    ).rejects.toBeInstanceOf(DepositAlreadyOnLedgerError);
  });

  it('does not credit a webhook redelivery of a deposit refunded from a finding', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet('5');
    await db.drizzle.db.insert(walletDepositAddress).values({
      userId: w.userId,
      currency: 'BTC',
      address: 'bc1qrefunded',
      providerName: 'custody',
    });
    await inTxn((txn) =>
      svc.recordRefundedDeposit(txn, {
        ...handDeposit(w.userId, { address: 'bc1qrefunded' }),
        providerRefId: 'refund-2',
      }),
    );

    await svc.creditDepositByAddress(redelivery('bc1qrefunded', 'refund-2'));

    expect(await balanceOf(w.userId)).toBe(5);
    expect(events.emitInTransaction).not.toHaveBeenCalled();
  });

  it('replays a hand-credited deposit on redelivery instead of crediting again', async () => {
    const { svc, events } = makeService();
    const w = await seedWallet('0');
    await db.drizzle.db
      .insert(walletDepositAddress)
      .values({ userId: w.userId, currency: 'BTC', address: 'bc1qhand', providerName: 'custody' });
    await inTxn((txn) =>
      svc.creditDepositByHand(txn, handDeposit(w.userId, { providerRefId: 'hand-1' })),
    );

    await svc.creditDepositByAddress(redelivery('bc1qhand', 'hand-1'));

    expect(await balanceOf(w.userId)).toBe(2);
    expect(events.emitInTransaction).not.toHaveBeenCalled();
  });

  it('answers who owns a deposit address, and nobody for an unknown one', async () => {
    const { svc } = makeService();
    const userId = randomUUID();
    await db.drizzle.db
      .insert(walletDepositAddress)
      .values({ userId, currency: 'BTC', address: 'bc1qowner', providerName: 'custody' });

    expect(
      await svc.depositAddressOwner({ address: 'bc1qowner', network: undefined, tag: undefined }),
    ).toBe(userId);
    expect(
      await svc.depositAddressOwner({ address: 'bc1qnobody', network: undefined, tag: undefined }),
    ).toBeUndefined();
  });
});

describe('WalletService.announceDepositCompleted (real PG)', () => {
  it('emits deposit.completed with the resolved player id', async () => {
    const { svc, events, playerId } = makeService();
    const deposit = {
      userId: randomUUID(),
      amount: '2',
      currency: 'BTC',
      transactionId: randomUUID(),
    };

    await inTxn((txn) => svc.announceDepositCompleted(txn, deposit));

    expect(events.emitInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      'wallet.deposit.completed',
      { ...deposit, playerId },
    );
  });
});
