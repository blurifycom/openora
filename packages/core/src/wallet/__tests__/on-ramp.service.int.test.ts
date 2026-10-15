import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import {
  queue,
  OnRampRefusedError,
  RgLimitExceededError,
  type GeoCheckCommands,
  type OnRampAdapter,
  type OnRampWebhookEvent,
  type PaymentAdapter,
  type PlayEligibilityPort,
  type RgLimitsPort,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import {
  mock,
  makeAdminGuard,
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makeJobQueue,
  makePaymentProviderRegistry,
  makeRealtimeTransport,
  NO_CLIENT_META,
  testContext,
} from '../../testing/mock.js';
import { createWalletRouter, type OnRampWebhookPort } from '../router/index.js';
import type { ReconciliationService } from '../service/reconciliation.service.js';
import { migrate } from '../migrate.js';
import {
  walletAsset,
  walletBalance,
  walletDepositAddress,
  walletTransaction,
} from '../schema/index.js';
import {
  DepositDisabledError,
  UnsupportedNetworkError,
  WalletService,
} from '../service/wallet.service.js';
import {
  OnRampGeoBlockedError,
  OnRampRestrictedError,
  OnRampService,
} from '../service/on-ramp.service.js';

let db: TestDb;

const GATEWAY_ID = 'gw-1';
const SIGNATURE = 'good-signature';

const OPTIONS = {
  fiats: [{ code: 'EUR', minAmount: '20', maxAmount: '5000', paymentMethods: ['card'] }],
  assets: [
    { currency: 'USDT', network: 'TRC20' },
    { currency: 'USDC', network: 'ERC20' },
    { currency: 'BTC', network: 'BTC' },
  ],
};

const QUOTE = {
  gatewayId: GATEWAY_ID,
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
  gatewayId: GATEWAY_ID,
};

function makeAdapter() {
  return {
    getOptions: vi.fn(async () => OPTIONS),
    getQuotes: vi.fn(async () => [QUOTE]),
    createCheckout: vi.fn(async () => ({
      externalId: 'order-1',
      checkoutUrl: 'https://checkout.example.test/order-1',
    })),
    parseWebhook: vi.fn(() => null),
  };
}

function makeService({
  adapter = makeAdapter(),
  audit = makeAuditWriter(),
  restricted = false,
  geoCheck,
  rgLimits,
}: {
  adapter?: ReturnType<typeof makeAdapter>;
  audit?: ReturnType<typeof makeAuditWriter>;
  restricted?: boolean;
  geoCheck?: GeoCheckCommands;
  rgLimits?: RgLimitsPort;
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
  });
  return { service, wallet, adapter, audit };
}

const geoAt = (allowed: boolean, countryCode: string | null): GeoCheckCommands => ({
  checkAccess: vi.fn(async () => ({ allowed, countryCode, redirectUrl: null })),
});

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

// The fake vendor's wire format is the event itself, signed with a fixed header.
const webhookPort: OnRampWebhookPort = {
  verify: (_rawBody, headers) => headers['x-signature'] === SIGNATURE,
  parse: (rawBody) => mock<OnRampWebhookEvent>(JSON.parse(rawBody)),
};

const webhookContext = (event: OnRampWebhookEvent, signature?: string) =>
  testContext({
    request: { headers: signature === undefined ? {} : { 'x-signature': signature } },
    rawBody: JSON.stringify(event),
  });

beforeAll(async () => {
  db = await createTestDb([migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${walletDepositAddress}, ${walletAsset}, ${walletTransaction}, ${walletBalance} RESTART IDENTITY CASCADE`,
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
    expect(adapter.getQuotes).not.toHaveBeenCalled();
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('refuses a geo-blocked caller', async () => {
    const { service, adapter } = makeService({ geoCheck: geoAt(false, 'XX') });
    await expect(
      service.checkout({ ...PURCHASE, userId: randomUUID(), idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(OnRampGeoBlockedError);
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
    const { service } = makeService();
    await expect(
      service.checkout({
        ...PURCHASE,
        fiatCurrency: 'GBP',
        userId: randomUUID(),
        idempotencyKey: randomUUID(),
      }),
    ).rejects.toMatchObject({ data: { reason: 'fiat_unsupported' } });
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

  it('refuses a gateway the server-side re-quote does not return', async () => {
    const { service, adapter } = makeService();
    const refusal = service.checkout({
      ...PURCHASE,
      gatewayId: 'gw-unknown',
      userId: randomUUID(),
      idempotencyKey: randomUUID(),
    });
    await expect(refusal).rejects.toBeInstanceOf(OnRampRefusedError);
    await expect(refusal).rejects.toMatchObject({ data: { reason: 'no_quote' } });
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('refuses a purchase over the deposit limit, checked on the quoted crypto amount', async () => {
    const checkDeposit = vi.fn(async () => ({
      allowed: false as const,
      limitType: 'deposit' as const,
      period: 'day' as const,
      limit: '50',
      used: '0',
    }));
    const { service, adapter } = makeService({
      rgLimits: mock<RgLimitsPort>({ checkDeposit }),
    });
    const userId = randomUUID();
    await expect(
      service.checkout({ ...PURCHASE, userId, idempotencyKey: randomUUID() }),
    ).rejects.toBeInstanceOf(RgLimitExceededError);
    expect(checkDeposit).toHaveBeenCalledWith(expect.anything(), userId, '98.5', 'USDT');
    expect(adapter.createCheckout).not.toHaveBeenCalled();
  });

  it('opens the checkout to a server-issued address, scoping the idempotency key to the player', async () => {
    const { service, adapter, audit } = makeService({ geoCheck: geoAt(true, 'DE') });
    const userId = randomUUID();
    const idempotencyKey = randomUUID();

    const checkout = await service.checkout({ ...PURCHASE, userId, idempotencyKey });

    expect(checkout).toEqual({
      externalId: 'order-1',
      checkoutUrl: 'https://checkout.example.test/order-1',
    });
    const [issued] = await db.drizzle.db
      .select()
      .from(walletDepositAddress)
      .where(eq(walletDepositAddress.userId, userId));
    expect(issued?.address).toBe(`T-${userId}`);
    expect(adapter.createCheckout).toHaveBeenCalledWith(
      expect.objectContaining({
        userId,
        gatewayId: GATEWAY_ID,
        walletAddress: `T-${userId}`,
        country: 'DE',
        idempotencyKey: `${userId}:${idempotencyKey}`,
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: 'player',
        actorId: userId,
        action: 'wallet.on_ramp.checkout_created',
        resourceId: 'order-1',
        after: expect.objectContaining({ gatewayId: GATEWAY_ID, fiatAmount: '100', country: 'DE' }),
      }),
    );
  });
});

describe('OnRampService.options (real PG)', () => {
  it('offers only the vendor assets the platform takes deposits in', async () => {
    const { service } = makeService();
    const options = await service.options(randomUUID(), NO_CLIENT_META);
    expect(options.assets).toEqual([{ currency: 'USDT', network: 'TRC20' }]);
  });
});

describe('wallet.onRamp routes', () => {
  it('answers a restricted player FORBIDDEN with the login refusal code', async () => {
    const { service, wallet } = makeService({ restricted: true });
    const router = routerWith({ service, wallet });
    const refusal = call(
      router.onRamp.checkout,
      { ...PURCHASE, idempotencyKey: randomUUID() },
      { context: testContext({ auth: { userId: randomUUID() } }) },
    );
    await expect(refusal).rejects.toBeInstanceOf(ORPCError);
    await expect(refusal).rejects.toMatchObject({
      code: 'FORBIDDEN',
      data: { code: 'RG_BLOCKED' },
    });
  });

  it('answers CONFLICT when no on-ramp vendor is bound', async () => {
    const { wallet } = makeService();
    const router = routerWith({ wallet });
    await expect(
      call(router.onRamp.options, undefined, {
        context: testContext({ auth: { userId: randomUUID() } }),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('POST /wallet/on-ramp/webhook', () => {
  const event = (over: Partial<OnRampWebhookEvent> = {}): OnRampWebhookEvent => ({
    externalId: 'order-1',
    status: 'completed',
    walletAddress: 'T-unknown',
    cryptoAmount: '98.5',
    ...over,
  });

  async function issuedAddressFor(wallet: WalletService, userId: string) {
    const { address } = await wallet.getOrCreateDepositAddress(userId, 'USDT', 'TRC20');
    return address;
  }

  it.each([
    ['a missing signature', undefined],
    ['a bad signature', 'forged'],
  ])('rejects %s with UNAUTHORIZED', async (_label, signature) => {
    const { service, wallet, audit } = makeService();
    const router = routerWith({ service, wallet }, webhookPort);
    await expect(
      call(router.onRamp.webhook, {}, { context: webhookContext(event(), signature) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('answers UNAUTHORIZED, not CONFLICT, when no vendor is bound', async () => {
    const { wallet } = makeService();
    const router = routerWith({ wallet });
    await expect(
      call(router.onRamp.webhook, {}, { context: webhookContext(event(), SIGNATURE) }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('acknowledges but ignores an address the platform never issued', async () => {
    const { service, wallet, audit } = makeService();
    const router = routerWith({ service, wallet }, webhookPort);
    await expect(
      call(router.onRamp.webhook, {}, { context: webhookContext(event(), SIGNATURE) }),
    ).resolves.toEqual({ ok: true });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('ignores an event whose customer is not the address owner', async () => {
    const { service, wallet, audit } = makeService();
    const walletAddress = await issuedAddressFor(wallet, randomUUID());
    const router = routerWith({ service, wallet }, webhookPort);
    await call(
      router.onRamp.webhook,
      {},
      { context: webhookContext(event({ walletAddress, customerId: randomUUID() }), SIGNATURE) },
    );
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('records a completed order for its owner and moves no balance', async () => {
    const { service, wallet, audit } = makeService();
    const userId = randomUUID();
    const walletAddress = await issuedAddressFor(wallet, userId);
    const router = routerWith({ service, wallet }, webhookPort);

    await expect(
      call(
        router.onRamp.webhook,
        {},
        { context: webhookContext(event({ walletAddress, customerId: userId }), SIGNATURE) },
      ),
    ).resolves.toEqual({ ok: true });

    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'wallet.on_ramp.status_changed',
        resourceId: 'order-1',
        after: expect.objectContaining({ userId, status: 'completed' }),
      }),
    );
    expect(await db.drizzle.db.select().from(walletTransaction)).toEqual([]);
    expect(await db.drizzle.db.select().from(walletBalance)).toEqual([]);
  });
});
