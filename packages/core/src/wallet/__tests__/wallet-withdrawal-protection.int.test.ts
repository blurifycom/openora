import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { call } from '@orpc/server';
import { and, eq, sql } from 'drizzle-orm';
import { findOneOrThrow } from '@openora/core/server';
import {
  queue,
  type PaymentAdapter,
  type WithdrawalPinVerdict,
  type WithdrawalSecurity,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  makeAdminGuard,
  makeAuditWriter,
  makeEventBus,
  makeExchangeRateReader,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
  makeRealtimeTransport,
  makeWithdrawalSecurity,
  mock,
  NO_CLIENT_META,
  testContext,
} from '../../testing/mock.js';
import { seedMatureWithdrawalAddress } from '../../testing/seed-wallet.js';
import { migrate } from '../migrate.js';
import { createWalletRouter } from '../router/index.js';
import {
  wallet,
  walletAsset,
  walletBalance,
  walletTransaction,
  walletWithdrawalAddress,
} from '../schema/index.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';
import {
  DestinationAddressCoolingDownError,
  WITHDRAWAL_ADDRESS_COOLDOWN_MS,
  WalletService,
  WithdrawalPinIncorrectError,
  WithdrawalPinLockedError,
  WithdrawalPinRequiredError,
} from '../service/wallet.service.js';

const HOUR_MS = 60 * 60 * 1000;
const ADDRESS = 'bc1qprotected';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${walletWithdrawalAddress}, ${walletAsset}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

const pinVerdict = (verdict: WithdrawalPinVerdict) =>
  makeWithdrawalSecurity({ verifyPin: vi.fn(async () => verdict) });

function makeService(security: WithdrawalSecurity = makeWithdrawalSecurity()) {
  const psp = {
    processDeposit: vi.fn(),
    processWithdrawal: vi.fn(async () => ({ externalId: randomUUID(), status: 'completed' })),
  };
  const svc = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>(psp),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
    rates: makeExchangeRateReader(),
    withdrawalSecurity: security,
  });
  return { svc, security };
}

async function seedWallet(currency: string, balance = '5') {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedWallet: no row'),
  );
  await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency, amount: balance });
  return row;
}

async function balanceOf(userId: string, currency: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(and(eq(wallet.userId, userId), eq(walletBalance.currency, currency)));
  return Number(row?.amount ?? 0);
}

const withdrawalRows = () => db.drizzle.db.select().from(walletTransaction);

const btcWithdrawal = (userId: string, over: Record<string, unknown> = {}) => ({
  userId,
  amount: '1',
  currency: 'BTC',
  destinationAddress: ADDRESS,
  ...NO_CLIENT_META,
  ...over,
});

describe('WalletService.withdraw - Withdrawal PIN (real PG)', () => {
  it('asks nothing of an account with no PIN', async () => {
    const { svc } = makeService();
    const w = await seedWallet('BTC');
    await seedMatureWithdrawalAddress(db, { userId: w.userId, currency: 'BTC', address: ADDRESS });

    await expect(svc.withdraw(btcWithdrawal(w.userId))).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
  });

  it('hands the PIN and the caller to the verifier, and withdraws on a match', async () => {
    const security = pinVerdict({ status: 'ok' });
    const { svc } = makeService(security);
    const w = await seedWallet('BTC');
    await seedMatureWithdrawalAddress(db, { userId: w.userId, currency: 'BTC', address: ADDRESS });

    await svc.withdraw(
      btcWithdrawal(w.userId, { withdrawalPin: '1234', ip: '203.0.113.9', userAgent: 'ua' }),
    );

    expect(security.verifyPin).toHaveBeenCalledWith({
      userId: w.userId,
      pin: '1234',
      meta: { ip: '203.0.113.9', userAgent: 'ua' },
    });
    expect(await withdrawalRows()).toHaveLength(1);
  });

  it('refuses a withdrawal that carries no PIN, and creates nothing', async () => {
    const { svc } = makeService(pinVerdict({ status: 'missing' }));
    const w = await seedWallet('BTC');
    await seedMatureWithdrawalAddress(db, { userId: w.userId, currency: 'BTC', address: ADDRESS });

    await expect(svc.withdraw(btcWithdrawal(w.userId))).rejects.toBeInstanceOf(
      WithdrawalPinRequiredError,
    );

    expect(await withdrawalRows()).toHaveLength(0);
    expect(await balanceOf(w.userId, 'BTC')).toBe(5);
  });

  it('refuses a wrong PIN with the attempts left, and creates nothing', async () => {
    const { svc } = makeService(pinVerdict({ status: 'incorrect', attemptsLeft: 3 }));
    const w = await seedWallet('BTC');
    await seedMatureWithdrawalAddress(db, { userId: w.userId, currency: 'BTC', address: ADDRESS });

    const refused = await svc
      .withdraw(btcWithdrawal(w.userId, { withdrawalPin: '0000' }))
      .catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(WithdrawalPinIncorrectError);
    expect((refused as WithdrawalPinIncorrectError).data).toEqual({
      reason: 'withdrawal_pin_incorrect',
      attemptsLeft: 3,
    });
    expect(await withdrawalRows()).toHaveLength(0);
    expect(await balanceOf(w.userId, 'BTC')).toBe(5);
  });

  it('refuses during a lock and says when it ends', async () => {
    const lockedUntil = new Date(Date.now() + 30 * 60 * 1000);
    const { svc } = makeService(pinVerdict({ status: 'locked', lockedUntil }));
    const w = await seedWallet('BTC');
    await seedMatureWithdrawalAddress(db, { userId: w.userId, currency: 'BTC', address: ADDRESS });

    const refused = await svc
      .withdraw(btcWithdrawal(w.userId, { withdrawalPin: '1234' }))
      .catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(WithdrawalPinLockedError);
    expect((refused as WithdrawalPinLockedError).data).toEqual({
      reason: 'withdrawal_pin_locked',
      lockedUntil: lockedUntil.toISOString(),
    });
    expect(await withdrawalRows()).toHaveLength(0);
  });

  it('asks for the PIN on a fiat withdrawal too', async () => {
    const { svc } = makeService(pinVerdict({ status: 'missing' }));
    const w = await seedWallet('USD', '100');

    await expect(
      svc.withdraw({ userId: w.userId, amount: '10', currency: 'USD', ...NO_CLIENT_META }),
    ).rejects.toBeInstanceOf(WithdrawalPinRequiredError);
    expect(await balanceOf(w.userId, 'USD')).toBe(100);
  });

  it('checks the PIN before the address, so a guess cannot be probed through other errors', async () => {
    const { svc } = makeService(pinVerdict({ status: 'incorrect', attemptsLeft: 4 }));
    const w = await seedWallet('BTC');

    await expect(
      svc.withdraw(btcWithdrawal(w.userId, { withdrawalPin: '0000' })),
    ).rejects.toBeInstanceOf(WithdrawalPinIncorrectError);
  });

  it('is enforced on the route too, with the reason and attempts left in the error data', async () => {
    const security = pinVerdict({ status: 'incorrect', attemptsLeft: 2 });
    const { svc } = makeService(security);
    const router = createWalletRouter({
      wallet: svc,
      adminGuard: makeAdminGuard({ caller: { userId: randomUUID(), role: 'admin' } }),
      audit: makeAuditWriter(),
      withdrawalSecurity: security,
      paymentProviders: makePaymentProviderRegistry(),
      reconciliation: mock<ReconciliationService>({}),
      jobQueue: makeJobQueue(),
      reconciliationQueue: queue('wallet-reconciliation'),
      realtime: makeRealtimeTransport(),
    });
    const w = await seedWallet('BTC');

    await expect(
      call(
        router.withdraw,
        {
          amount: '1',
          currency: 'BTC',
          idempotencyKey: randomUUID(),
          destinationAddress: 'bc1qrouteaddress0000000000000000000000000',
          withdrawalPin: '0000',
        },
        { context: testContext({ auth: { userId: w.userId } }) },
      ),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      data: { reason: 'withdrawal_pin_incorrect', attemptsLeft: 2 },
    });
    expect(await withdrawalRows()).toHaveLength(0);
  });
});

describe('WalletService.withdraw - the 24-hour wait on a payout address (real PG)', () => {
  const saveAddress = (userId: string, ageMs: number, over: { destinationTag?: string } = {}) =>
    seedMatureWithdrawalAddress(db, {
      userId,
      currency: 'BTC',
      address: ADDRESS,
      network: 'BITCOIN',
      ageMs,
      ...over,
    });

  const seedBitcoinAsset = () =>
    db.drizzle.db.execute(
      sql`INSERT INTO wallet_asset (currency, network, provider_asset_id, min_deposit, min_withdrawal, withdrawal_fee) VALUES ('BTC', 'BITCOIN', 'BTC', 0, 0, 0)`,
    );

  it('refuses an address that was never saved, however the request is sent', async () => {
    const { svc } = makeService();
    const w = await seedWallet('BTC');

    const refused = await svc.withdraw(btcWithdrawal(w.userId)).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(DestinationAddressCoolingDownError);
    expect((refused as DestinationAddressCoolingDownError).data).toEqual({
      reason: 'withdrawal_address_not_saved',
    });
    expect(await withdrawalRows()).toHaveLength(0);
    expect(await balanceOf(w.userId, 'BTC')).toBe(5);
  });

  it('refuses an address saved an hour ago and says when it becomes usable', async () => {
    const { svc } = makeService();
    const w = await seedWallet('BTC');
    await seedBitcoinAsset();
    await saveAddress(w.userId, HOUR_MS);
    const [saved] = await db.drizzle.db.select().from(walletWithdrawalAddress);

    const refused = await svc.withdraw(btcWithdrawal(w.userId)).catch((err: unknown) => err);

    expect(refused).toBeInstanceOf(DestinationAddressCoolingDownError);
    expect((refused as DestinationAddressCoolingDownError).data).toEqual({
      reason: 'withdrawal_address_cooling_down',
      usableFrom: new Date(
        saved!.createdAt.getTime() + WITHDRAWAL_ADDRESS_COOLDOWN_MS,
      ).toISOString(),
    });
    expect(await withdrawalRows()).toHaveLength(0);
    expect(await balanceOf(w.userId, 'BTC')).toBe(5);
  });

  it('refuses just inside the 24 hours and accepts just past them', async () => {
    const { svc } = makeService();
    const w = await seedWallet('BTC');
    await seedBitcoinAsset();

    await saveAddress(w.userId, 24 * HOUR_MS - 60_000);
    await expect(svc.withdraw(btcWithdrawal(w.userId))).rejects.toBeInstanceOf(
      DestinationAddressCoolingDownError,
    );

    await db.drizzle.db.delete(walletWithdrawalAddress);
    await saveAddress(w.userId, 24 * HOUR_MS + 60_000);
    await expect(svc.withdraw(btcWithdrawal(w.userId))).resolves.toMatchObject({
      transactionId: expect.any(String),
    });
  });

  it('treats the same address under another tag as never saved', async () => {
    const { svc } = makeService();
    const w = await seedWallet('BTC');
    await saveAddress(w.userId, 48 * HOUR_MS, { destinationTag: '1000' });

    await expect(
      svc.withdraw(btcWithdrawal(w.userId, { destinationTag: '2000' })),
    ).rejects.toBeInstanceOf(DestinationAddressCoolingDownError);
  });

  it('does not let one player lean on the wait another player already served', async () => {
    const { svc } = makeService();
    const owner = await seedWallet('BTC');
    const other = await seedWallet('BTC');
    await saveAddress(owner.userId, 48 * HOUR_MS);

    await expect(svc.withdraw(btcWithdrawal(other.userId))).rejects.toBeInstanceOf(
      DestinationAddressCoolingDownError,
    );
  });

  it('leaves a fiat withdrawal, which has no address, alone', async () => {
    const { svc } = makeService();
    const w = await seedWallet('USD', '100');

    await expect(
      svc.withdraw({ userId: w.userId, amount: '10', currency: 'USD', ...NO_CLIENT_META }),
    ).resolves.toMatchObject({ transactionId: expect.any(String) });
  });

  describe('auto-approval', () => {
    const unmatured = (svc: WalletService, txId: string, userId: string) =>
      (
        svc as unknown as {
          destinationIsUnmatured(tx: string, user: string, currency: string): Promise<boolean>;
        }
      ).destinationIsUnmatured(txId, userId, 'BTC');

    const pendingTo = async (walletId: string, address: string | null) => {
      const [row] = await db.drizzle.db
        .insert(walletTransaction)
        .values({
          walletId,
          type: 'withdrawal',
          amount: '1',
          currency: 'BTC',
          status: 'pending',
          rail: address ? 'crypto' : 'fiat',
          network: address ? 'BITCOIN' : null,
          destinationAddress: address,
        })
        .returning();
      return row!;
    };

    it('holds a payout to an address younger than 24 hours for a human', async () => {
      const { svc } = makeService();
      const w = await seedWallet('BTC');
      await saveAddress(w.userId, HOUR_MS);
      const tx = await pendingTo(w.id, ADDRESS);

      await expect(unmatured(svc, tx.id, w.userId)).resolves.toBe(true);
    });

    it('holds a payout to an address that is not saved at all', async () => {
      const { svc } = makeService();
      const w = await seedWallet('BTC');
      const tx = await pendingTo(w.id, ADDRESS);

      await expect(unmatured(svc, tx.id, w.userId)).resolves.toBe(true);
    });

    it('lets auto-approval work as usual once the address is past 24 hours', async () => {
      const { svc } = makeService();
      const w = await seedWallet('BTC');
      await saveAddress(w.userId, 25 * HOUR_MS);
      const tx = await pendingTo(w.id, ADDRESS);

      await expect(unmatured(svc, tx.id, w.userId)).resolves.toBe(false);
    });

    it('does not hold a withdrawal that has no address', async () => {
      const { svc } = makeService();
      const w = await seedWallet('BTC');
      const tx = await pendingTo(w.id, null);

      await expect(unmatured(svc, tx.id, w.userId)).resolves.toBe(false);
    });
  });
});
