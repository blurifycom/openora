import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type {
  PaymentAdapter,
  PaymentWebhookEvent,
  PaymentWebhookVerifier,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  testContext,
  makeAuditWriter,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import { wallet, walletBalance, walletTransaction, walletDepositAddress } from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';

const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';
const DEPOSIT_ADDRESS = 'bc1qxyz';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(walletTransaction);
  await db.drizzle.db.delete(walletDepositAddress);
  await db.drizzle.db.delete(walletBalance);
  await db.drizzle.db.delete(wallet);
});

function routerWith(payment: PaymentAdapter, verifier: PaymentWebhookVerifier) {
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment,
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
  });
  return createWalletRouter(
    service,
    mock<AdminGuard>({ assert: vi.fn() }),
    makeAuditWriter(),
    payment,
    verifier,
  );
}

const verifierReturning = (result: boolean) =>
  mock<PaymentWebhookVerifier>({ verify: vi.fn().mockReturnValue(result) });

const paymentParsing = (event: PaymentWebhookEvent | null) =>
  mock<PaymentAdapter>({ parseWebhook: vi.fn().mockReturnValue(event) });

function ctx(rawBody: string, headers: Record<string, string> = {}) {
  return { context: testContext({ request: { headers }, rawBody }) };
}

async function seedWallet(currency = 'BTC') {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(wallet)
      .values({ userId: USER_ID, balance: '0', currency })
      .returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: row.balance });
  return row;
}

async function seedDepositAddress(currency = 'BTC') {
  await db.drizzle.db.insert(walletDepositAddress).values({
    userId: USER_ID,
    currency,
    address: DEPOSIT_ADDRESS,
    providerName: 'fireblocks',
  });
}

async function seedProcessingWithdrawal(walletId: string, externalId: string) {
  const row = findOneOrThrow(
    await db.drizzle.db
      .insert(walletTransaction)
      .values({
        walletId,
        type: 'withdrawal',
        amount: '1',
        currency: 'BTC',
        status: 'processing',
        rail: 'crypto',
        providerRefId: externalId,
      })
      .returning(),
    new Error('seedProcessingWithdrawal: query returned no row'),
  );
  return row;
}

async function ledgerFor(walletId: string) {
  return db.drizzle.db
    .select()
    .from(walletTransaction)
    .where(eq(walletTransaction.walletId, walletId));
}

const depositEvent: PaymentWebhookEvent = {
  kind: 'deposit',
  address: DEPOSIT_ADDRESS,
  amount: '0.5',
  currency: 'BTC',
  txHash: '0xabc',
  externalId: 'vendor-ext-1',
};

describe('wallet webhook route (M2M, no admin session)', () => {
  it('rejects when the signature verifier fails (fail closed)', async () => {
    const w = await seedWallet();
    await seedDepositAddress();
    const payment = paymentParsing(depositEvent);
    const router = routerWith(payment, verifierReturning(false));

    await expect(
      call(router.webhook, {}, ctx('{}', { 'x-payment-signature': 'bad' })),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(payment.parseWebhook).not.toHaveBeenCalled();
    expect(await ledgerFor(w.id)).toHaveLength(0);
  });

  it('rejects when no raw body was captured', async () => {
    const verifier = verifierReturning(true);
    const router = routerWith(paymentParsing(depositEvent), verifier);

    await expect(call(router.webhook, {}, { context: testContext() })).rejects.toBeInstanceOf(
      ORPCError,
    );
    expect(verifier.verify).not.toHaveBeenCalled();
  });

  it('credits the player wallet on a verified deposit event', async () => {
    const w = await seedWallet();
    await seedDepositAddress();
    const router = routerWith(paymentParsing(depositEvent), verifierReturning(true));

    const result = await call(router.webhook, {}, ctx('{"event":"deposit"}'));

    expect(result).toEqual({ ok: true });
    const ledger = await ledgerFor(w.id);
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      type: 'deposit',
      status: 'completed',
      amount: '0.500000000000000000',
      providerRefId: 'vendor-ext-1',
      txHash: '0xabc',
    });
    const [credited] = await db.drizzle.db
      .select()
      .from(walletBalance)
      .where(eq(walletBalance.walletId, w.id));
    expect(credited?.amount).toBe('0.500000000000000000');
  });

  it('credits a replayed deposit event exactly once', async () => {
    const w = await seedWallet();
    await seedDepositAddress();
    const router = routerWith(paymentParsing(depositEvent), verifierReturning(true));

    await call(router.webhook, {}, ctx('{"event":"deposit"}'));
    await call(router.webhook, {}, ctx('{"event":"deposit"}'));

    expect(await ledgerFor(w.id)).toHaveLength(1);
    const [credited] = await db.drizzle.db
      .select()
      .from(walletBalance)
      .where(eq(walletBalance.walletId, w.id));
    expect(credited?.amount).toBe('0.500000000000000000');
  });

  it('settles the matching withdrawal on a verified withdrawal event', async () => {
    const w = await seedWallet();
    const externalId = randomUUID();
    const withdrawal = await seedProcessingWithdrawal(w.id, externalId);
    const router = routerWith(
      paymentParsing({ kind: 'withdrawal', externalId, status: 'completed', txHash: '0xdef' }),
      verifierReturning(true),
    );

    const result = await call(router.webhook, {}, ctx('{"event":"withdrawal"}'));

    expect(result).toEqual({ ok: true });
    const [settled] = await db.drizzle.db
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.id, withdrawal.id));
    expect(settled).toMatchObject({ status: 'completed', txHash: '0xdef' });
  });

  it('returns ok without touching the ledger when parseWebhook does not recognize the body', async () => {
    const w = await seedWallet();
    await seedDepositAddress();
    const router = routerWith(paymentParsing(null), verifierReturning(true));

    const result = await call(router.webhook, {}, ctx('{"event":"unknown"}'));

    expect(result).toEqual({ ok: true });
    expect(await ledgerFor(w.id)).toHaveLength(0);
  });

  it('returns ok and credits nothing when the deposit address is unknown', async () => {
    const w = await seedWallet();
    const router = routerWith(paymentParsing(depositEvent), verifierReturning(true));

    const result = await call(router.webhook, {}, ctx('{"event":"deposit"}'));

    expect(result).toEqual({ ok: true });
    expect(await ledgerFor(w.id)).toHaveLength(0);
  });
});
