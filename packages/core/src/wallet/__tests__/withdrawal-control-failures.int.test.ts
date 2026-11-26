import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { findOneOrThrow, type EventBus } from '@openora/core/server';
import {
  DEFAULT_PAYMENT_PROVIDER,
  type AdminPlayerSummary,
  type AdminUserDirectory,
  type AuditWritePort,
  type ExchangeRateReader,
  type IdentityReader,
  type KycWithdrawalPolicy,
  type PaymentAdapter,
  type PaymentProviderRegistry,
  type PaymentWebhookVerifier,
  type PlatformConfig,
  type PlayerTags,
  type WithdrawalSecurity,
} from '@openora/core/contracts';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { createTestDb, type TestDb } from '../../testing/real-infra.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletWithdrawalAddress,
} from '../schema/index.js';
import { WalletService } from '../service/wallet.service.js';

const ADDRESS = 'bc1qcontrolfailure';
const NO_CLIENT_META = { ip: null, userAgent: null };

const double = <T extends object>(partial: Partial<T>): T => Object.assign({} as T, partial);

const events = double<EventBus>({
  emit: vi.fn(),
  on: vi.fn(),
  emitInTransaction: vi.fn(),
});

const audit: AuditWritePort = {
  auditedTopics: new Set<string>(),
  record: vi.fn(async () => undefined),
  recordInTransaction: vi.fn(async () => undefined),
  recordManyInTransaction: vi.fn(async () => undefined),
};

const identityReader = double<IdentityReader>({
  getPlayerIdByUserId: vi.fn(async () => null),
  getPlayerIdByUserIdSafe: vi.fn(async () => null),
  getPlayerKycStatusByUserId: vi.fn(async () => null),
  canReceiveLoginWithdrawalAlerts: vi.fn(async () => false),
});

const rates: ExchangeRateReader = {
  getRate: vi.fn(async () => ({ rate: '1', asOf: new Date().toISOString() })),
  convert: vi.fn(async (amount: string) => amount),
};

const paymentProviders: PaymentProviderRegistry = {
  get: (name) =>
    name === DEFAULT_PAYMENT_PROVIDER
      ? {
          adapter: double<PaymentAdapter>({
            processWithdrawal: vi.fn(async () => ({
              externalId: randomUUID(),
              status: 'completed' as const,
            })),
          }),
          webhookVerifier: double<PaymentWebhookVerifier>({ verify: vi.fn(() => false) }),
        }
      : null,
  names: () => [DEFAULT_PAYMENT_PROVIDER],
};

const riskTags: PlayerTags = { getActiveTagKeys: vi.fn(async () => new Map()) };

const openSecurity = (overrides: Partial<WithdrawalSecurity> = {}): WithdrawalSecurity => ({
  verifyPin: vi.fn<WithdrawalSecurity['verifyPin']>(async () => ({ status: 'not_set' })),
  pinLockedUntil: vi.fn<WithdrawalSecurity['pinLockedUntil']>(async () => null),
  assertReauthentication: vi.fn<WithdrawalSecurity['assertReauthentication']>(
    async () => undefined,
  ),
  ...overrides,
});

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletTransaction}, ${wallet} RESTART IDENTITY CASCADE`,
  );
});

function makeService(controls: {
  kycPolicy?: KycWithdrawalPolicy;
  withdrawalSecurity?: WithdrawalSecurity;
}) {
  return new WalletService({
    drizzle: db.drizzle,
    events,
    payment: double<PaymentAdapter>({}),
    paymentProviders,
    audit,
    identityReader,
    rates,
    riskTags,
    kycPolicy: controls.kycPolicy ?? { requiresKycForWithdrawal: vi.fn(async () => false) },
    withdrawalSecurity: controls.withdrawalSecurity ?? openSecurity(),
    directory: double<AdminUserDirectory>({
      lookupPlayers: vi.fn(async (ids: string[]) =>
        ids.map((userId) =>
          double<AdminPlayerSummary>({ userId, username: 'p', kycStatus: 'pending' }),
        ),
      ),
    }),
    platformConfig: double<PlatformConfig>({
      kyc: { gateWithdrawals: true, requireApprovalForDirectOverride: false },
    }),
  });
}

async function seedWallet(currency: string, amount: string) {
  const row = findOneOrThrow(
    await db.drizzle.db.insert(wallet).values({ userId: randomUUID(), currency }).returning(),
    new Error('seedWallet: no row'),
  );
  await db.drizzle.db.insert(walletBalance).values({ walletId: row.id, currency, amount });
  return row;
}

async function seedMatureAddress(userId: string) {
  await db.drizzle.db.insert(walletWithdrawalAddress).values({
    userId,
    currency: 'BTC',
    address: ADDRESS,
    label: 'Seeded',
    network: 'ANY',
    destinationTag: null,
    createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
  });
}

const withdrawalRows = () => db.drizzle.db.select().from(walletTransaction);

async function balanceOf(userId: string, currency: string) {
  const [row] = await db.drizzle.db
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(and(eq(wallet.userId, userId), eq(walletBalance.currency, currency)));
  return Number(row?.amount ?? 0);
}

const withdrawal = (userId: string, currency: string, amount: string) => ({
  userId,
  amount,
  currency,
  ...(currency === 'BTC' ? { destinationAddress: ADDRESS } : {}),
  ...NO_CLIENT_META,
});

describe('a failing KYC policy', () => {
  it('refuses the request without debiting', async () => {
    const svc = makeService({
      kycPolicy: {
        requiresKycForWithdrawal: vi.fn(() => Promise.reject(new Error('compliance down'))),
      },
    });
    const w = await seedWallet('USD', '100');

    await expect(svc.withdraw(withdrawal(w.userId, 'USD', '50'))).rejects.toThrow(
      'compliance down',
    );

    expect(await withdrawalRows()).toHaveLength(0);
    expect(await balanceOf(w.userId, 'USD')).toBe(100);
  });

  it('refuses the approval and leaves the withdrawal queued', async () => {
    const requiresKycForWithdrawal = vi.fn(async () => false);
    const svc = makeService({ kycPolicy: { requiresKycForWithdrawal } });
    const w = await seedWallet('USD', '100');
    const { transactionId } = await svc.withdraw(withdrawal(w.userId, 'USD', '50'));
    requiresKycForWithdrawal.mockRejectedValueOnce(new Error('compliance down'));

    await expect(svc.approveWithdrawal(randomUUID(), transactionId)).rejects.toThrow(
      'compliance down',
    );

    const [queued] = await withdrawalRows();
    expect(queued?.status).toBe('pending');
  });
});

describe('a failing withdrawal PIN verifier', () => {
  it('refuses the request and creates nothing', async () => {
    const svc = makeService({
      withdrawalSecurity: openSecurity({
        verifyPin: vi.fn(() => Promise.reject(new Error('identity down'))),
      }),
    });
    const w = await seedWallet('BTC', '5');
    await seedMatureAddress(w.userId);

    await expect(svc.withdraw(withdrawal(w.userId, 'BTC', '1'))).rejects.toThrow('identity down');

    expect(await withdrawalRows()).toHaveLength(0);
    expect(await balanceOf(w.userId, 'BTC')).toBe(5);
  });

  it('refuses the approval when the lockout read throws and leaves it queued', async () => {
    const withdrawalSecurity = openSecurity();
    const svc = makeService({ withdrawalSecurity });
    const w = await seedWallet('BTC', '5');
    await seedMatureAddress(w.userId);
    const { transactionId } = await svc.withdraw(withdrawal(w.userId, 'BTC', '1'));
    vi.mocked(withdrawalSecurity.pinLockedUntil).mockRejectedValueOnce(new Error('identity down'));

    await expect(svc.approveWithdrawal(randomUUID(), transactionId)).rejects.toThrow(
      'identity down',
    );

    const [queued] = await withdrawalRows();
    expect(queued).toMatchObject({ status: 'pending', reviewedBy: null });
  });
});
