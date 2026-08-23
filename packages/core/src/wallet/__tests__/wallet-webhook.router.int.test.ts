import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { findOneOrThrow } from '@openora/core/server';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import {
  queue,
  type PaymentAdapter,
  type PaymentProviderRegistry,
  type PaymentWebhookEvent,
  type PaymentWebhookVerifier,
  type RateLimiterAdapter,
  type RateLimitKey,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import {
  mock,
  makeEventBus,
  makeIdentityReader,
  testContext,
  makeAuditWriter,
  makeJobQueue,
  makePaymentProviderRegistry,
} from '../../testing/mock.js';
import { migrate } from '../migrate.js';
import {
  wallet,
  walletBalance,
  walletTransaction,
  walletDepositAddress,
  walletReconciliationFinding,
} from '../schema/index.js';
import { createWalletRouter } from '../router/index.js';
import { WalletService } from '../service/wallet.service.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';

const USER_ID = '63d3c264-3bf4-4d08-9b92-ea3eaf40a440';
const DEPOSIT_ADDRESS = 'bc1qxyz';
const RECONCILIATION_QUEUE = queue('wallet-reconciliation');

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.delete(walletReconciliationFinding);
  await db.drizzle.db.delete(walletTransaction);
  await db.drizzle.db.delete(walletDepositAddress);
  await db.drizzle.db.delete(walletBalance);
  await db.drizzle.db.delete(wallet);
});

function routerWith(
  payment: PaymentAdapter,
  verifier: PaymentWebhookVerifier,
  limiter?: RateLimiterAdapter<RateLimitKey>,
) {
  const paymentProviders = makePaymentProviderRegistry({
    adapter: payment,
    webhookVerifier: verifier,
  });
  return routerWithProviders(paymentProviders, payment, limiter);
}

function routerWithProviders(
  paymentProviders: PaymentProviderRegistry,
  payment: PaymentAdapter,
  limiter?: RateLimiterAdapter<RateLimitKey>,
) {
  const service = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment,
    paymentProviders,
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
  });
  return createWalletRouter({
    wallet: service,
    adminGuard: mock<AdminGuard>({ assert: vi.fn() }),
    audit: makeAuditWriter(),
    paymentProviders,
    reconciliation: mock<ReconciliationService>({}),
    jobQueue: makeJobQueue(),
    reconciliationQueue: RECONCILIATION_QUEUE,
    limiter,
  });
}

async function findingsFor(externalId: string) {
  return db.drizzle.db
    .select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.externalId, externalId));
}

// A registry with two DISTINCTLY-behaving named providers, to test that a webhook is
// never verified with one vendor's key and parsed with another's format.
function twoProviderRegistry(
  a: { payment: PaymentAdapter; verifier: PaymentWebhookVerifier },
  b: { payment: PaymentAdapter; verifier: PaymentWebhookVerifier },
): PaymentProviderRegistry {
  return {
    get: (name) => {
      if (name === 'vendor-a') {
        return { adapter: a.payment, webhookVerifier: a.verifier };
      }
      if (name === 'vendor-b') {
        return { adapter: b.payment, webhookVerifier: b.verifier };
      }
      return null;
    },
    names: () => ['vendor-a', 'vendor-b'],
  };
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
    await db.drizzle.db.insert(wallet).values({ userId: USER_ID, currency }).returning(),
    new Error('seedWallet: query returned no row'),
  );
  await db.drizzle.db
    .insert(walletBalance)
    .values({ walletId: row.id, currency: row.currency, amount: '0' });
  return row;
}

async function seedDepositAddress(currency = 'BTC') {
  await db.drizzle.db.insert(walletDepositAddress).values({
    userId: USER_ID,
    currency,
    address: DEPOSIT_ADDRESS,
    providerName: 'custody',
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

  it('returns ok, credits nobody, and files an unattributed_deposit finding when the deposit address is unknown', async () => {
    const w = await seedWallet();
    const router = routerWith(paymentParsing(depositEvent), verifierReturning(true));

    const result = await call(router.webhook, {}, ctx('{"event":"deposit"}'));

    expect(result).toEqual({ ok: true });
    expect(await ledgerFor(w.id)).toHaveLength(0);
    const findings = await findingsFor(depositEvent.externalId);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: 'unattributed_deposit',
      providerName: 'default',
      currency: 'BTC',
      amount: '0.500000000000000000',
      address: DEPOSIT_ADDRESS,
      status: 'open',
    });
  });
});

describe('POST /wallet/webhook/{provider} (multi-provider routing)', () => {
  it('resolves the verifier AND the adapter from the same named provider entry', async () => {
    const w = await seedWallet();
    await seedDepositAddress();
    const a = { payment: paymentParsing(depositEvent), verifier: verifierReturning(true) };
    const b = { payment: paymentParsing(depositEvent), verifier: verifierReturning(true) };
    const router = routerWithProviders(twoProviderRegistry(a, b), a.payment);

    const result = await call(
      router.webhookForProvider,
      { provider: 'vendor-a' },
      ctx('{"event":"deposit"}'),
    );

    expect(result).toEqual({ ok: true });
    expect(a.verifier.verify).toHaveBeenCalledTimes(1);
    expect(a.payment.parseWebhook).toHaveBeenCalledTimes(1);
    expect(await ledgerFor(w.id)).toHaveLength(1);
  });

  it('never verifies with one provider and parses with another (signature confusion)', async () => {
    const a = { payment: paymentParsing(depositEvent), verifier: verifierReturning(true) };
    const b = { payment: paymentParsing(depositEvent), verifier: verifierReturning(true) };
    const router = routerWithProviders(twoProviderRegistry(a, b), a.payment);

    await call(router.webhookForProvider, { provider: 'vendor-a' }, ctx('{"event":"deposit"}'));

    expect(a.verifier.verify).toHaveBeenCalledTimes(1);
    expect(b.verifier.verify).not.toHaveBeenCalled();
    expect(b.payment.parseWebhook).not.toHaveBeenCalled();
  });

  it('an unknown provider name fails the same shape as a bad signature, without calling any bound verifier', async () => {
    const a = { payment: paymentParsing(depositEvent), verifier: verifierReturning(true) };
    const b = { payment: paymentParsing(depositEvent), verifier: verifierReturning(true) };
    const router = routerWithProviders(twoProviderRegistry(a, b), a.payment);

    await expect(
      call(
        router.webhookForProvider,
        { provider: 'not-a-bound-vendor' },
        ctx('{"event":"deposit"}'),
      ),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(a.verifier.verify).not.toHaveBeenCalled();
    expect(b.verifier.verify).not.toHaveBeenCalled();
  });

  it('rejects a bad signature on the named-provider route the same way as the default route', async () => {
    const a = { payment: paymentParsing(depositEvent), verifier: verifierReturning(false) };
    const b = { payment: paymentParsing(depositEvent), verifier: verifierReturning(true) };
    const router = routerWithProviders(twoProviderRegistry(a, b), a.payment);

    await expect(
      call(router.webhookForProvider, { provider: 'vendor-a' }, ctx('{"event":"deposit"}')),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(a.payment.parseWebhook).not.toHaveBeenCalled();
  });

  it('the unparameterised route keeps working, delegating to the default provider', async () => {
    const w = await seedWallet();
    await seedDepositAddress();
    const router = routerWith(paymentParsing(depositEvent), verifierReturning(true));

    const result = await call(router.webhook, {}, ctx('{"event":"deposit"}'));

    expect(result).toEqual({ ok: true });
    expect(await ledgerFor(w.id)).toHaveLength(1);
  });
});

describe('wallet webhook route - per-IP rate limit', () => {
  function exhaustedLimiter(): RateLimiterAdapter<RateLimitKey> {
    return {
      consume: vi.fn(async () => ({ allowed: false, retryAfterMs: 1000 })),
      reset: vi.fn(async () => undefined),
    };
  }

  it('rejects with 429 once the per-IP limiter denies the request', async () => {
    const limiter = exhaustedLimiter();
    const router = routerWith(paymentParsing(null), verifierReturning(true), limiter);

    await expect(
      call(
        router.webhook,
        {},
        {
          context: testContext({
            request: { headers: {} },
            rawBody: '{}',
            clientMeta: { ip: '1.2.3.4', userAgent: null },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(limiter.consume).toHaveBeenCalledTimes(1);
  });

  it('still rate-limits a request with no IP, under a shared bucket rather than skipping the limiter', async () => {
    const limiter = exhaustedLimiter();
    const router = routerWith(paymentParsing(null), verifierReturning(true), limiter);

    await expect(
      call(
        router.webhook,
        {},
        {
          context: testContext({
            request: { headers: {} },
            rawBody: '{}',
            clientMeta: { ip: null, userAgent: null },
          }),
        },
      ),
    ).rejects.toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    expect(limiter.consume).toHaveBeenCalledTimes(1);
    const [key] = (limiter.consume as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(key).toBe('wallet-webhook:unknown');
  });

  it('does not consume the limiter twice for the same request beyond the one throttle check', async () => {
    const limiter: RateLimiterAdapter<RateLimitKey> = {
      consume: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
      reset: vi.fn(async () => undefined),
    };
    await seedWallet();
    await seedDepositAddress();
    const router = routerWith(paymentParsing(depositEvent), verifierReturning(true), limiter);

    await call(router.webhook, {}, ctx('{"event":"deposit"}'));

    expect(limiter.consume).toHaveBeenCalledTimes(1);
  });
});
