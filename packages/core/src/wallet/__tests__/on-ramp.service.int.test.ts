import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type * as z from 'zod';
import { RedisRateLimiter } from '@openora/core/server';
import {
  makeRateLimitKey,
  queue,
  OnRampVendorUnavailableError,
  RATE_LIMIT_KEYS,
  RgLimitExceededError,
  type GeoCheckCommands,
  type OnRampAdapter,
  type OnRampWebhookEvent,
  type PaymentAdapter,
  type PlayEligibilityPort,
  type RateLimitKey,
  type RateLimiterAdapter,
  type RgLimitsPort,
} from '@openora/core/contracts';
import { createTestDb, createTestRedis, type TestDb, type TestRedis } from '@openora/core/testing';
import {
  mock,
  makeAdminGuard,
  makeAuditWriter,
  makeCache,
  makeEventBus,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
  makeRealtimeTransport,
  NO_CLIENT_META,
  testContext,
} from '../../testing/mock.js';
import type { OnRampCheckoutInputSchema } from '../contract/index.js';
import { createWalletRouter, type OnRampWebhookPort } from '../router/index.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';
import { migrate } from '../migrate.js';
import {
  walletAsset,
  walletBalance,
  walletDepositAddress,
  walletOnRampOrder,
  walletTransaction,
} from '../schema/index.js';
import {
  DepositDisabledError,
  IdempotencyKeyReuseError,
  UnsupportedNetworkError,
  WalletService,
} from '../service/wallet.service.js';
import {
  OnRampGeoBlockedError,
  OnRampRestrictedError,
  OnRampService,
} from '../service/on-ramp.service.js';

let db: TestDb;
let redis: TestRedis;

const SIGNATURE = 'good-signature';
const RACING_ORDERS = 5;

const settleConcurrentCalls = () => new Promise((resolve) => setTimeout(resolve, 50));

const OPTIONS = {
  fiats: [{ code: 'EUR', minAmount: '20', maxAmount: '5000' }],
  assets: [
    { currency: 'USDT', network: 'TRC20' },
    { currency: 'USDC', network: 'ERC20' },
    { currency: 'BTC', network: 'BTC' },
  ],
};

const QUOTE = {
  gatewayId: 'gw-1',
  gatewayName: 'Gateway One',
  fiatCurrency: 'EUR',
  fiatAmount: '100',
  currency: 'USDT',
  network: 'TRC20',
  cryptoAmount: '98.5',
  fee: '1.5',
  feeCurrency: 'EUR',
  rate: '1',
  expiresAt: '2026-01-01T00:15:00.000Z',
};

const PURCHASE = {
  meta: { ip: '203.0.113.10', userAgent: null },
  fiatCurrency: 'EUR',
  fiatAmount: '100',
  currency: 'USDT',
  network: 'TRC20',
};

function makeAdapter() {
  return {
    getOptions: vi.fn(async () => OPTIONS),
    getQuotes: vi.fn(async () => [QUOTE]),
    createCheckout: vi.fn(async () => {
      const externalId = `order-${randomUUID()}`;
      return {
        externalId,
        checkoutUrl: `https://checkout.example.test/${externalId}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      };
    }),
    // Whatever the vendor answers: core validates it.
    getStatus: vi.fn(async (): Promise<unknown> => 'pending'),
    parseWebhook: vi.fn(() => null),
  };
}

function makeService({
  adapter = makeAdapter(),
  audit = makeAuditWriter(),
  restricted = false,
  geoCheck,
  rgLimits,
  limiter,
  cache,
}: {
  adapter?: ReturnType<typeof makeAdapter>;
  audit?: ReturnType<typeof makeAuditWriter>;
  restricted?: boolean;
  geoCheck?: GeoCheckCommands;
  rgLimits?: RgLimitsPort;
  limiter?: RateLimiterAdapter<RateLimitKey>;
  cache?: ReturnType<typeof makeCache>;
} = {}) {
  const issueDepositAddress = vi.fn(async (userId: string) => ({ address: `T-${userId}` }));
  const wallet = new WalletService({
    drizzle: db.drizzle,
    events: makeEventBus(),
    payment: mock<PaymentAdapter>({ issueDepositAddress }),
    paymentProviders: makePaymentProviderRegistry(),
    audit: makeAuditWriter(),
    identityReader: makeIdentityReader(),
  });
  const service = new OnRampService({
    drizzle: db.drizzle,
    wallet,
    adapter: mock<OnRampAdapter>(adapter),
    audit,
    playEligibility: mock<PlayEligibilityPort>({ isRestricted: vi.fn(async () => restricted) }),
    geoCheck,
    rgLimits,
    limiter,
    cache,
  });
  return { service, wallet, adapter, audit };
}

const geoAt = (allowed: boolean, countryCode: string | null): GeoCheckCommands => ({
  checkAccess: vi.fn(async () => ({ allowed, countryCode, redirectUrl: null })),
});

const allowAll = () =>
  mock<RgLimitsPort>({ checkDeposit: vi.fn(async () => ({ allowed: true as const })) });

function routerWith(
  { service, wallet }: { service?: OnRampService; wallet: WalletService },
  onRampWebhook?: OnRampWebhookPort,
) {
  return createWalletRouter({
    wallet,
    onRamp: service,
    onRampWebhook,
    adminGuard: makeAdminGuard({ caller: { userId: randomUUID(), role: 'admin' } }),
    audit: makeAuditWriter(),
    paymentProviders: makePaymentProviderRegistry(),
    reconciliation: mock<ReconciliationService>({}),
    jobQueue: makeJobQueue(),
    reconciliationQueue: queue('wallet-reconciliation'),
    realtime: makeRealtimeTransport(),
  });
}

type OnRampCheckoutInput = z.input<typeof OnRampCheckoutInputSchema>;

const playerContext = (userId: string) => testContext({ auth: { userId } });

// The fake vendor's wire format is the event itself, signed with a fixed header.
const webhookPort: OnRampWebhookPort = {
  verify: (_rawBody, headers) => headers['x-signature'] === SIGNATURE,
  parse: (rawBody) => mock<OnRampWebhookEvent>(JSON.parse(rawBody)),
};

// Any JSON body: the parser hands back whatever the vendor sent, valid or not.
const webhookContext = (event: object, signature?: string) =>
  testContext({
    request: { headers: signature === undefined ? {} : { 'x-signature': signature } },
    rawBody: JSON.stringify(event),
  });

async function orderRow(purchaseId: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(walletOnRampOrder)
    .where(eq(walletOnRampOrder.id, purchaseId));
  if (!row) {
    throw new Error(`no on-ramp order ${purchaseId}`);
  }
  return row;
}

async function openOrder(service: OnRampService, userId = randomUUID()) {
  const { purchaseId } = await service.checkout({
    ...PURCHASE,
    userId,
    idempotencyKey: randomUUID(),
  });
  // Only what happens once the order is open is under test.
  vi.clearAllMocks();
  return orderRow(purchaseId);
}

beforeAll(async () => {
  db = await createTestDb([migrate]);
  redis = await createTestRedis();
});

afterAll(async () => {
  await db.drop();
  await redis.quit();
});

beforeEach(async () => {
  await redis.flush();
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletOnRampOrder}, ${walletDepositAddress}, ${walletAsset}, ${walletTransaction}, ${walletBalance} RESTART IDENTITY CASCADE`,
  );
  await db.drizzle.db.insert(walletAsset).values([
    {
      currency: 'USDT',
      network: 'TRC20',
      providerAssetId: 'usdt-trc20',
      minDeposit: '1',
      minWithdrawal: '1',
      withdrawalFee: '0',
    },
    {
      currency: 'USDC',
      network: 'ERC20',
      providerAssetId: 'usdc-erc20',
      minDeposit: '1',
      minWithdrawal: '1',
      withdrawalFee: '0',
      depositEnabled: false,
    },
  ]);
});

describe('OnRampService.checkout gates (real PG)', () => {
  it('refuses a restricted player before the vendor is asked anything', async () => {
    const { service, adapter } = makeService({ restricted: true });
    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(OnRampRestrictedError);
    expect(adapter.getOptions).not.toHaveBeenCalled();
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('refuses a geo-blocked caller before the vendor is asked anything', async () => {
    const { service, adapter } = makeService({ geoCheck: geoAt(false, 'XX') });
    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(OnRampGeoBlockedError);
    expect(adapter.getOptions).not.toHaveBeenCalled();
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('refuses to replay a checkout to a player restricted since the first attempt', async () => {
    const isRestricted = vi.fn(async () => false);
    const { wallet, adapter } = makeService();
    const restrictedLater = new OnRampService({
      drizzle: db.drizzle,
      wallet,
      adapter: mock<OnRampAdapter>(adapter),
      audit: makeAuditWriter(),
      playEligibility: mock<PlayEligibilityPort>({ isRestricted }),
    });
    const purchase = { ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() };
    await restrictedLater.checkout(purchase);
    isRestricted.mockResolvedValue(true);

    await expect(restrictedLater.checkout(purchase)).rejects.toBeInstanceOf(OnRampRestrictedError);
    expect(adapter.createCheckout).toHaveBeenCalledOnce();
  });

  it('refuses a depositable pair the vendor does not sell, like a non-depositable one', async () => {
    await db.drizzle.db.insert(walletAsset).values({
      currency: 'USDT',
      network: 'ERC20',
      providerAssetId: 'usdt-erc20',
      minDeposit: '1',
      minWithdrawal: '1',
      withdrawalFee: '0',
    });
    const { service, adapter } = makeService();
    await expect(
      service.checkout({
        ...PURCHASE,
        network: 'ERC20',
        userId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(DepositDisabledError);
    expect(adapter.getQuotes).not.toHaveBeenCalled();
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['10', { reason: 'below_minimum', fiatCurrency: 'EUR', minAmount: '20' }],
    ['5000.01', { reason: 'above_maximum', fiatCurrency: 'EUR', maxAmount: '5000' }],
  ])('refuses %s EUR outside the vendor range with typed data', async (fiatAmount, data) => {
    const { service, adapter } = makeService();
    await expect(
      service.checkout({
        ...PURCHASE,
        fiatAmount,
        userId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ data });
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('refuses a fiat the vendor does not offer', async () => {
    const { service, adapter } = makeService();
    await expect(
      service.checkout({
        ...PURCHASE,
        fiatCurrency: 'GBP',
        userId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ data: { reason: 'fiat_unsupported' } });
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it.each([
    ['USDC', 'ERC20', DepositDisabledError],
    ['USDT', 'BEP20', UnsupportedNetworkError],
  ])(
    'refuses %s on %s, which the platform takes no deposits in',
    async (currency, network, err) => {
      const { service, adapter } = makeService();
      await expect(
        service.checkout({
          ...PURCHASE,
          currency,
          network,
          userId: randomUUID(),
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toBeInstanceOf(err);
      expect(adapter.getQuotes).not.toHaveBeenCalled();
      expect(adapter.createCheckout).not.toHaveBeenCalled();
    },
  );

  it('refuses an estimate that would deliver less than the network deposit minimum', async () => {
    const adapter = makeAdapter();
    adapter.getQuotes.mockResolvedValue([{ ...QUOTE, cryptoAmount: '0.5' }]);
    const { service } = makeService({ adapter });
    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({
      data: {
        reason: 'below_deposit_minimum',
        currency: 'USDT',
        network: 'TRC20',
        minDeposit: '1.000000000000000000',
      },
    });
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('still opens a checkout when the vendor has no estimate', async () => {
    const adapter = makeAdapter();
    adapter.getQuotes.mockResolvedValue([]);
    const { service } = makeService({ adapter });
    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).resolves.toMatchObject({ checkoutUrl: expect.stringMatching(/^https:\/\//) });
    expect(adapter.createCheckout).toHaveBeenCalledOnce();
  });

  it('checks the deposit limit on the fiat amount plus the open orders in that fiat', async () => {
    const rgLimits = allowAll();
    const { service } = makeService({ rgLimits });
    const userId = randomUUID();
    const order = {
      userId,
      fiatCurrency: 'EUR',
      currency: 'USDT',
      network: 'TRC20',
      walletAddress: `T-${userId}`,
    };
    const longAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const expired = new Date(Date.now() - 60 * 1000);
    const live = new Date(Date.now() + 60 * 60 * 1000);
    await db.drizzle.db.insert(walletOnRampOrder).values([
      {
        ...order,
        idempotencyKey: randomUUID(),
        fiatAmount: '30',
        status: 'processing',
        createdAt: longAgo,
        expiresAt: expired,
      },
      {
        ...order,
        idempotencyKey: randomUUID(),
        fiatAmount: '20',
        status: 'pending',
        createdAt: longAgo,
        expiresAt: live,
      },
      { ...order, idempotencyKey: randomUUID(), fiatAmount: '40', status: 'pending' },
      {
        ...order,
        idempotencyKey: randomUUID(),
        fiatAmount: '1000',
        status: 'pending',
        expiresAt: expired,
      },
      {
        ...order,
        idempotencyKey: randomUUID(),
        fiatAmount: '400',
        status: 'pending',
        createdAt: longAgo,
      },
      { ...order, idempotencyKey: randomUUID(), fiatAmount: '500', status: 'completed' },
      {
        ...order,
        idempotencyKey: randomUUID(),
        fiatAmount: '700',
        fiatCurrency: 'GBP',
        status: 'processing',
      },
      {
        ...order,
        userId: randomUUID(),
        idempotencyKey: randomUUID(),
        fiatAmount: '900',
        status: 'processing',
      },
    ]);

    await service.checkout({ ...PURCHASE, userId, idempotencyKey: randomUUID() });

    expect(rgLimits.checkDeposit).toHaveBeenCalledWith(
      expect.anything(),
      userId,
      expect.anything(),
      'EUR',
    );
    const attempted = vi.mocked(rgLimits.checkDeposit).mock.calls[0]?.[2];
    expect(Number(attempted)).toBe(190);
  });

  it('refuses a purchase over the deposit limit with the limit currency in the data', async () => {
    const checkDeposit = vi.fn(async () => ({
      allowed: false as const,
      limitType: 'deposit' as const,
      period: 'day' as const,
      limit: '50',
      used: '0',
      currency: 'EUR',
    }));
    const { service, adapter } = makeService({ rgLimits: mock<RgLimitsPort>({ checkDeposit }) });
    const refusal = service.checkout({
      ...PURCHASE,
      userId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    await expect(refusal).rejects.toBeInstanceOf(RgLimitExceededError);
    await expect(refusal).rejects.toMatchObject({ data: { limit: '50', currency: 'EUR' } });
    expect(adapter.createCheckout).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(walletOnRampOrder)).toEqual([]);
  });

  it('counts the open orders as used in a deposit limit refusal', async () => {
    const checkDeposit = vi.fn(async () => ({
      allowed: false as const,
      limitType: 'deposit' as const,
      period: 'day' as const,
      limit: '100',
      used: '10',
      currency: 'EUR',
    }));
    const { service } = makeService({ rgLimits: mock<RgLimitsPort>({ checkDeposit }) });
    const userId = randomUUID();
    await db.drizzle.db.insert(walletOnRampOrder).values({
      userId,
      idempotencyKey: randomUUID(),
      fiatAmount: '80',
      fiatCurrency: 'EUR',
      currency: 'USDT',
      network: 'TRC20',
      walletAddress: `T-${userId}`,
      status: 'pending',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const refusal = service.checkout({
      ...PURCHASE,
      fiatAmount: '50',
      userId,
      idempotencyKey: randomUUID(),
    });

    await expect(refusal).rejects.toMatchObject({
      data: { limit: '100', used: expect.stringMatching(/^90(\.0+)?$/), currency: 'EUR' },
    });
  });

  it.each([
    ['the limit is in another currency', { limit: '100', used: '10', currency: 'USD' }],
    ['the gate could not price the attempt', { limit: '100', used: '100', currency: 'EUR' }],
  ])('reports the gate used unchanged when %s', async (_label, refused) => {
    const checkDeposit = vi.fn(async () => ({
      allowed: false as const,
      limitType: 'deposit' as const,
      period: 'day' as const,
      ...refused,
    }));
    const { service } = makeService({ rgLimits: mock<RgLimitsPort>({ checkDeposit }) });
    const userId = randomUUID();
    await db.drizzle.db.insert(walletOnRampOrder).values({
      userId,
      idempotencyKey: randomUUID(),
      fiatAmount: '80',
      fiatCurrency: 'EUR',
      currency: 'USDT',
      network: 'TRC20',
      walletAddress: `T-${userId}`,
      status: 'processing',
    });

    await expect(
      service.checkout({ ...PURCHASE, userId, idempotencyKey: randomUUID() }),
    ).rejects.toMatchObject({ data: refused });
  });

  it('lets only one of two concurrent checkouts through a limit both would fit alone', async () => {
    const checkDeposit = vi.fn(async (_tx: unknown, _userId: string, attempted: string) => {
      await settleConcurrentCalls();
      return Number(attempted) <= 150
        ? { allowed: true as const }
        : {
            allowed: false as const,
            limitType: 'deposit' as const,
            period: 'day' as const,
            limit: '150',
            used: '0',
            currency: 'EUR',
          };
    });
    const { service, wallet, adapter } = makeService({
      rgLimits: mock<RgLimitsPort>({ checkDeposit }),
    });
    const userId = randomUUID();
    await wallet.getOrCreateDepositAddress(userId, 'USDT', 'TRC20');

    const results = await Promise.allSettled([
      service.checkout({ ...PURCHASE, userId, idempotencyKey: randomUUID() }),
      service.checkout({ ...PURCHASE, userId, idempotencyKey: randomUUID() }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toMatchObject([
      { reason: expect.any(RgLimitExceededError) },
    ]);
    expect(adapter.createCheckout).toHaveBeenCalledOnce();
    expect(await db.drizzle.db.select().from(walletOnRampOrder)).toHaveLength(1);
  });

  it.each([
    ['the vendor fails to estimate', () => Promise.reject(new OnRampVendorUnavailableError())],
    [
      'the vendor estimate is malformed',
      () => Promise.resolve([{ ...QUOTE, cryptoAmount: '1e-3' }]),
    ],
  ])('still opens a checkout when %s', async (_label, getQuotes) => {
    const adapter = makeAdapter();
    adapter.getQuotes.mockImplementation(getQuotes);
    const { service } = makeService({ adapter });

    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).resolves.toMatchObject({ checkoutUrl: expect.stringMatching(/^https:\/\//) });
    expect(adapter.createCheckout).toHaveBeenCalledOnce();
  });

  it('fails the order when recording the opened checkout fails', async () => {
    const { service, audit } = makeService();
    audit.recordInTransaction.mockRejectedValueOnce(new Error('audit store down'));

    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toThrow('audit store down');

    expect(await db.drizzle.db.select().from(walletOnRampOrder)).toMatchObject([
      { status: 'failed', checkoutUrl: null },
    ]);
    expect(audit.recordInTransaction).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'wallet.on_ramp.checkout_failed' }),
    );
  });

  it('records the order against a server-issued address before the vendor opens it', async () => {
    const { service, adapter, audit } = makeService({
      geoCheck: geoAt(true, 'DE'),
      rgLimits: allowAll(),
    });
    const userId = randomUUID();
    const idempotencyKey = randomUUID();

    const checkout = await service.checkout({ ...PURCHASE, userId, idempotencyKey });

    const row = await orderRow(checkout.purchaseId);
    expect(row).toMatchObject({
      userId,
      status: 'pending',
      walletAddress: `T-${userId}`,
      fiatCurrency: 'EUR',
      currency: 'USDT',
      network: 'TRC20',
      checkoutUrl: checkout.checkoutUrl,
    });
    expect(row.externalId).toMatch(/^order-/);
    expect(row.expiresAt?.getTime()).toBeGreaterThan(Date.now());
    const [issued] = await db.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, userId));
    expect(issued?.address).toBe(`T-${userId}`);
    expect(adapter.createCheckout).toHaveBeenCalledWith({
      userId,
      purchaseId: row.id,
      fiatCurrency: 'EUR',
      fiatAmount: '100',
      currency: 'USDT',
      network: 'TRC20',
      walletAddress: `T-${userId}`,
      walletTag: undefined,
      country: 'DE',
      idempotencyKey: `${userId}:${idempotencyKey}`,
    });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        actorType: 'player',
        actorId: userId,
        action: 'wallet.on_ramp.checkout_created',
        resourceId: row.id,
        after: {
          purchaseId: row.id,
          externalId: row.externalId,
          fiatAmount: '100',
          fiatCurrency: 'EUR',
          currency: 'USDT',
          network: 'TRC20',
          walletAddress: `T-${userId}`,
          country: 'DE',
          expiresAt: row.expiresAt?.toISOString(),
          acknowledged: true,
          idempotencyKey,
        },
      }),
    );
  });

  it('replays the original checkout for a retried key and refuses the key for another purchase', async () => {
    const { service, adapter } = makeService();
    const userId = randomUUID();
    const idempotencyKey = randomUUID();

    const first = await service.checkout({ ...PURCHASE, userId, idempotencyKey });
    const retry = await service.checkout({ ...PURCHASE, userId, idempotencyKey });

    expect(retry).toEqual(first);
    expect(adapter.createCheckout).toHaveBeenCalledOnce();
    await expect(
      service.checkout({ ...PURCHASE, fiatAmount: '200', userId, idempotencyKey }),
    ).rejects.toBeInstanceOf(IdempotencyKeyReuseError);
  });

  it('marks the order failed and audits only the error class when the vendor cannot open it', async () => {
    const adapter = makeAdapter();
    adapter.createCheckout.mockRejectedValue(
      new OnRampVendorUnavailableError({ cause: new Error('upstream 503: internal detail') }),
    );
    const { service, audit } = makeService({ adapter });
    const userId = randomUUID();
    const idempotencyKey = randomUUID();

    await expect(service.checkout({ ...PURCHASE, userId, idempotencyKey })).rejects.toBeInstanceOf(
      OnRampVendorUnavailableError,
    );

    const rows = await db.drizzle.db.select().from(walletOnRampOrder);
    expect(rows).toMatchObject([{ userId, status: 'failed', externalId: null }]);
    expect(audit.recordInTransaction).toHaveBeenCalledOnce();
    expect(audit.recordInTransaction).toHaveBeenCalledWith(expect.anything(), {
      actorType: 'player',
      actorId: userId,
      action: 'wallet.on_ramp.checkout_failed',
      resourceType: 'on_ramp_order',
      resourceId: rows[0]?.id,
      after: {
        purchaseId: rows[0]?.id,
        fiatAmount: '100',
        fiatCurrency: 'EUR',
        currency: 'USDT',
        network: 'TRC20',
        idempotencyKey,
        error: 'OnRampVendorUnavailableError',
      },
      ...PURCHASE.meta,
    });
  });

  it.each([
    ['an http checkout url', { checkoutUrl: 'http://checkout.example.test/x' }],
    ['a script url', { checkoutUrl: 'javascript:alert(1)' }],
    ['no expiry', { expiresAt: 'soon' }],
  ])('fails the order and answers unavailable for %s', async (_label, over) => {
    const adapter = makeAdapter();
    adapter.createCheckout.mockResolvedValue({
      externalId: 'order-bad',
      checkoutUrl: 'https://checkout.example.test/order-bad',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      ...over,
    });
    const { service } = makeService({ adapter });

    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(OnRampVendorUnavailableError);

    expect(await db.drizzle.db.select().from(walletOnRampOrder)).toMatchObject([
      { status: 'failed', checkoutUrl: null, externalId: null },
    ]);
  });
});

describe('OnRampService.options and quote (real PG)', () => {
  it('offers only the vendor assets the platform takes deposits in', async () => {
    const { service } = makeService();
    const options = await service.options(randomUUID(), NO_CLIENT_META);
    expect(options).toEqual({
      fiats: OPTIONS.fiats,
      assets: [{ currency: 'USDT', network: 'TRC20' }],
    });
  });

  it('asks the vendor for its options once per country while cached', async () => {
    const { service, adapter } = makeService({ cache: makeCache() });
    await service.options(randomUUID(), NO_CLIENT_META);
    await service.options(randomUUID(), NO_CLIENT_META);
    expect(adapter.getOptions).toHaveBeenCalledOnce();
  });

  it('answers unavailable when the vendor options are malformed', async () => {
    const adapter = makeAdapter();
    adapter.getOptions.mockResolvedValue({
      ...OPTIONS,
      fiats: [{ code: 'EUR', minAmount: 'twenty', maxAmount: '5000' }],
    });
    const { service } = makeService({ adapter });
    await expect(service.options(randomUUID(), NO_CLIENT_META)).rejects.toBeInstanceOf(
      OnRampVendorUnavailableError,
    );
    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(OnRampVendorUnavailableError);
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('answers unavailable when a vendor estimate is malformed', async () => {
    const adapter = makeAdapter();
    adapter.getQuotes.mockResolvedValue([{ ...QUOTE, cryptoAmount: '1e-3' }]);
    const { service } = makeService({ adapter });
    await expect(service.quote({ ...PURCHASE, userId: randomUUID() })).rejects.toBeInstanceOf(
      OnRampVendorUnavailableError,
    );
  });

  it('answers an empty list when the vendor has no estimate', async () => {
    const adapter = makeAdapter();
    adapter.getQuotes.mockResolvedValue([]);
    const { service } = makeService({ adapter });
    await expect(service.quote({ ...PURCHASE, userId: randomUUID() })).resolves.toEqual([]);
  });

  it('throttles on its own key, apart from wallet mutations', async () => {
    const limiter = new RedisRateLimiter(redis.client);
    const { service } = makeService({ limiter });
    const userId = randomUUID();
    const mutationKey = makeRateLimitKey(RATE_LIMIT_KEYS.WALLET_MUTATION, userId);
    for (let i = 0; i < 30; i++) {
      await limiter.consume(mutationKey, { limit: 30, windowMs: 60_000 });
    }
    expect((await limiter.consume(mutationKey, { limit: 30, windowMs: 60_000 })).allowed).toBe(
      false,
    );

    // An exhausted wallet-mutation budget does not block buying crypto, and vice versa.
    for (let i = 0; i < 30; i++) {
      await service.options(userId, NO_CLIENT_META);
    }
    await expect(service.options(userId, NO_CLIENT_META)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(service.quote({ ...PURCHASE, userId })).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    expect(
      (
        await limiter.consume(makeRateLimitKey(RATE_LIMIT_KEYS.ON_RAMP, randomUUID()), {
          limit: 30,
          windowMs: 60_000,
        })
      ).allowed,
    ).toBe(true);
  });
});

describe('OnRampService.getOrder (real PG)', () => {
  it('refreshes an open order from the vendor and audits the move', async () => {
    const { service, adapter, audit } = makeService();
    const row = await openOrder(service);
    adapter.getStatus.mockResolvedValue('processing');

    await expect(service.getOrder(row.userId, row.id)).resolves.toEqual({
      purchaseId: row.id,
      status: 'processing',
      fiatAmount: row.fiatAmount,
      fiatCurrency: 'EUR',
      currency: 'USDT',
      network: 'TRC20',
    });
    expect(adapter.getStatus).toHaveBeenCalledWith(row.externalId);
    expect((await orderRow(row.id)).status).toBe('processing');
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'wallet.on_ramp.status_changed',
        resourceId: row.id,
        after: expect.objectContaining({ userId: row.userId, from: 'pending', to: 'processing' }),
      }),
    );
  });

  it('does not ask the vendor again once the order is terminal', async () => {
    const { service, adapter } = makeService();
    const row = await openOrder(service);
    adapter.getStatus.mockResolvedValue('completed');
    await service.getOrder(row.userId, row.id);
    adapter.getStatus.mockClear();

    await expect(service.getOrder(row.userId, row.id)).resolves.toMatchObject({
      status: 'completed',
    });
    expect(adapter.getStatus).not.toHaveBeenCalled();
  });

  it('asks the vendor about an order at most once per cache window', async () => {
    const { service, adapter } = makeService({ cache: makeCache() });
    const row = await openOrder(service);

    await service.getOrder(row.userId, row.id);
    await service.getOrder(row.userId, row.id);

    expect(adapter.getStatus).toHaveBeenCalledOnce();
  });

  it('ignores a vendor status outside the status set', async () => {
    const { service, adapter, audit } = makeService();
    const row = await openOrder(service);
    adapter.getStatus.mockResolvedValue('settled');

    await expect(service.getOrder(row.userId, row.id)).resolves.toMatchObject({
      status: 'pending',
    });
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('throttles status reads on their own key, apart from buying', async () => {
    const limiter = new RedisRateLimiter(redis.client);
    const { service } = makeService({ limiter });
    const row = await openOrder(service);
    for (let i = 0; i < 29; i++) {
      await service.getOrder(row.userId, row.id);
    }
    await expect(service.getOrder(row.userId, row.id)).resolves.toMatchObject({
      purchaseId: row.id,
    });
    await expect(service.getOrder(row.userId, row.id)).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
    });
    await expect(service.options(row.userId, NO_CLIENT_META)).resolves.toBeDefined();
  });

  it('answers the stored status when the vendor is down', async () => {
    const { service, adapter, audit } = makeService();
    const row = await openOrder(service);
    adapter.getStatus.mockRejectedValue(new OnRampVendorUnavailableError());

    await expect(service.getOrder(row.userId, row.id)).resolves.toMatchObject({
      status: 'pending',
    });
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });
});

describe('wallet.onRamp routes', () => {
  it('answers a restricted player FORBIDDEN with the login refusal code', async () => {
    const { service, wallet } = makeService({ restricted: true });
    const router = routerWith({ service, wallet });
    const refusal = call(
      router.onRamp.checkout,
      { ...PURCHASE, idempotencyKey: randomUUID(), acknowledged: true },
      { context: playerContext(randomUUID()) },
    );
    await expect(refusal).rejects.toBeInstanceOf(ORPCError);
    await expect(refusal).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { code: 'RG_BLOCKED' },
    });
  });

  it.each([
    ['missing', {}],
    ['false', { acknowledged: false }],
  ])('rejects a checkout with acknowledged %s before the service runs', async (_label, ack) => {
    const { service, wallet, adapter } = makeService();
    const router = routerWith({ service, wallet });
    await expect(
      call(
        router.onRamp.checkout,
        mock<OnRampCheckoutInput>({ ...PURCHASE, idempotencyKey: randomUUID(), ...ack }),
        { context: playerContext(randomUUID()) },
      ),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(adapter.getOptions).not.toHaveBeenCalled();
  });

  it('answers CONFLICT when no on-ramp vendor is bound', async () => {
    const { wallet } = makeService();
    const router = routerWith({ wallet });
    await expect(
      call(router.onRamp.options, undefined, { context: playerContext(randomUUID()) }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'buying crypto is unavailable' });
  });

  it('answers a vendor outage like an unbound vendor, without the vendor message', async () => {
    const adapter = makeAdapter();
    adapter.getQuotes.mockRejectedValue(
      new OnRampVendorUnavailableError({ cause: new Error('upstream 503: internal detail') }),
    );
    const { service, wallet } = makeService({ adapter });
    const router = routerWith({ service, wallet });
    await expect(
      call(router.onRamp.quote, PURCHASE, { context: playerContext(randomUUID()) }),
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'buying crypto is unavailable' });
  });

  it("answers another player's order NOT_FOUND, like an unknown one", async () => {
    const { service, wallet, adapter } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet });

    await expect(
      call(router.onRamp.order, { purchaseId: row.id }, { context: playerContext(row.userId) }),
    ).resolves.toMatchObject({ purchaseId: row.id, status: 'pending' });
    adapter.getStatus.mockClear();
    await expect(
      call(router.onRamp.order, { purchaseId: row.id }, { context: playerContext(randomUUID()) }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      call(
        router.onRamp.order,
        { purchaseId: randomUUID() },
        { context: playerContext(row.userId) },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(adapter.getStatus).not.toHaveBeenCalled();
  });
});

describe('POST /wallet/on-ramp/webhook', () => {
  const eventFor = (
    row: Awaited<ReturnType<typeof orderRow>>,
    over: Partial<OnRampWebhookEvent> = {},
  ): OnRampWebhookEvent => ({
    purchaseId: row.id,
    externalId: row.externalId ?? '',
    status: 'completed',
    walletAddress: row.walletAddress,
    externalCustomerId: row.userId,
    cryptoAmount: '98.5',
    txHash: '0xabc',
    gatewayId: 'gw-1',
    ...over,
  });

  const deliver = (
    router: ReturnType<typeof routerWith>,
    event: object,
    signature: string | undefined = SIGNATURE,
  ) => call(router.onRamp.webhook, {}, { context: webhookContext(event, signature) });

  it.each([
    ['a missing signature', undefined],
    ['a bad signature', 'forged'],
  ])('rejects %s with UNAUTHORIZED', async (_label, signature) => {
    const { service, wallet, audit } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);
    await expect(
      call(router.onRamp.webhook, {}, { context: webhookContext(eventFor(row), signature) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await orderRow(row.id)).status).toBe('pending');
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers UNAUTHORIZED, not a 500, when the verifier throws', async () => {
    const { service, wallet } = makeService();
    const row = await openOrder(service);
    const router = routerWith(
      { service, wallet },
      {
        ...webhookPort,
        verify: () => {
          throw new Error('secret not configured');
        },
      },
    );
    await expect(deliver(router, eventFor(row))).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect((await orderRow(row.id)).status).toBe('pending');
  });

  it.each([
    ['an unknown status', { status: 'settled' }],
    ['a non-decimal crypto amount', { cryptoAmount: '1e3' }],
    ['an empty external id', { externalId: '' }],
  ])('acknowledges but ignores an event with %s', async (_label, over) => {
    const { service, wallet, audit } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);

    await expect(deliver(router, { ...eventFor(row), ...over })).resolves.toEqual({ ok: true });

    expect((await orderRow(row.id)).status).toBe('pending');
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('answers UNAUTHORIZED, not CONFLICT, when no vendor is bound', async () => {
    const { wallet } = makeService();
    const router = routerWith({ wallet });
    await expect(
      deliver(router, { externalId: 'order-x', status: 'completed' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('moves the order and audits the transition, crediting nothing', async () => {
    const { service, wallet, audit } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);

    await expect(deliver(router, eventFor(row))).resolves.toEqual({ ok: true });

    expect(await orderRow(row.id)).toMatchObject({
      status: 'completed',
      txHash: '0xabc',
      gatewayId: 'gw-1',
      cryptoAmount: '98.500000000000000000',
    });
    expect(audit.recordInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'wallet.on_ramp.status_changed',
        resourceId: row.id,
        after: {
          userId: row.userId,
          from: 'pending',
          to: 'completed',
          txHash: '0xabc',
          gatewayId: 'gw-1',
          cryptoAmount: '98.500000000000000000',
        },
      }),
    );
    expect(await db.drizzle.db.select().from(walletTransaction)).toEqual([]);
    expect(await db.drizzle.db.select().from(walletBalance)).toEqual([]);
  });

  it('finds the order by its external id when the vendor does not echo the purchase id', async () => {
    const { service, wallet } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);

    await deliver(router, eventFor(row, { purchaseId: undefined, status: 'processing' }));

    expect((await orderRow(row.id)).status).toBe('processing');
  });

  it('writes nothing on a redelivery or an out-of-order open status', async () => {
    const { service, wallet, audit } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);

    await deliver(router, eventFor(row));
    await deliver(router, eventFor(row));
    await deliver(router, eventFor(row, { status: 'processing' }));

    expect(audit.recordInTransaction).toHaveBeenCalledOnce();
    expect((await orderRow(row.id)).status).toBe('completed');
  });

  it.each([
    ['processing', 'pending'],
    ['completed', 'expired'],
    ['refunded', 'completed'],
  ] as const)('ignores a move from %s back to %s', async (from, to) => {
    const { service, wallet, audit } = makeService();
    const row = await openOrder(service);
    await db.drizzle.db
      .update(walletOnRampOrder)
      .set({ status: from })
      .where(eq(walletOnRampOrder.id, row.id));
    const router = routerWith({ service, wallet }, webhookPort);

    await expect(deliver(router, eventFor(row, { status: to }))).resolves.toEqual({ ok: true });

    expect((await orderRow(row.id)).status).toBe(from);
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
  });

  it('ends on the latest status whichever of two racing deliveries lands first', async () => {
    const { service, wallet } = makeService();
    const rows = await Promise.all(Array.from({ length: RACING_ORDERS }, () => openOrder(service)));
    const router = routerWith({ service, wallet }, webhookPort);

    await Promise.all(
      rows.flatMap((row) => [
        deliver(router, eventFor(row, { status: 'processing' })),
        deliver(router, eventFor(row, { status: 'completed' })),
      ]),
    );

    for (const row of rows) {
      expect((await orderRow(row.id)).status).toBe('completed');
    }
  });

  it('records delivery details a same-status update adds', async () => {
    const { service, wallet, audit } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);
    await deliver(
      router,
      eventFor(row, { status: 'processing', txHash: undefined, cryptoAmount: undefined }),
    );
    await deliver(router, eventFor(row, { status: 'processing', txHash: '0xdef' }));

    expect(await orderRow(row.id)).toMatchObject({
      status: 'processing',
      txHash: '0xdef',
      cryptoAmount: '98.500000000000000000',
    });
    expect(audit.recordInTransaction).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'wallet.on_ramp.order_updated',
        after: expect.objectContaining({ from: 'processing', to: 'processing', txHash: '0xdef' }),
      }),
    );
  });

  it('refunds a completed order', async () => {
    const { service, wallet } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);

    await deliver(router, eventFor(row));
    await deliver(router, eventFor(row, { status: 'refunded' }));

    expect((await orderRow(row.id)).status).toBe('refunded');
  });

  it.each([
    ['wallet', { walletAddress: 'T-somebody-else' }],
    ['wallet', { walletTag: 'memo-1' }],
    ['customer', { externalCustomerId: randomUUID() }],
  ])('ignores an event whose %s disagrees with the order', async (mismatch, over) => {
    const { service, wallet, audit } = makeService();
    const row = await openOrder(service);
    const router = routerWith({ service, wallet }, webhookPort);

    await expect(deliver(router, eventFor(row, over))).resolves.toEqual({ ok: true });

    expect((await orderRow(row.id)).status).toBe('pending');
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.on_ramp.webhook_mismatch',
        resourceId: row.id,
        after: expect.objectContaining({ mismatch }),
      }),
    );
  });

  it('acknowledges but ignores an event for an order the platform never opened', async () => {
    const { service, wallet, audit } = makeService();
    const router = routerWith({ service, wallet }, webhookPort);

    await expect(
      deliver(router, {
        purchaseId: randomUUID(),
        externalId: 'order-unknown',
        status: 'completed',
        walletAddress: 'T-unknown',
      }),
    ).resolves.toEqual({ ok: true });

    expect(audit.record).not.toHaveBeenCalled();
    expect(audit.recordInTransaction).not.toHaveBeenCalled();
    expect(await db.drizzle.db.select().from(walletOnRampOrder)).toEqual([]);
  });
});
