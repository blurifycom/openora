import { afterAll, beforeAll, expect, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { PaymentWebhookEvent } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import {
  wallet,
  walletBalance,
  walletDepositAddress,
  walletDepositStatusEvent,
  walletJobRun,
  walletReconciliationFinding,
  walletTransaction,
} from '@openora/core/wallet/schema';
import {
  asAdmin,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../../index.js';
import {
  setTestPaymentTransactions,
  signTestPaymentWebhook,
  TEST_PAYMENT_SIGNATURE_HEADER,
} from '../../test-payment-webhook-plugin.js';

const paymentPluginPath = fileURLToPath(
  new URL('../../test-payment-webhook-plugin.ts', import.meta.url),
);
const reconciliationConfigPluginPath = fileURLToPath(
  new URL('./test-wallet-reconciliation-config-plugin.ts', import.meta.url),
);

export const NETWORK = 'TESTCHAIN';
export const OTHER_NETWORK = 'OTHERCHAIN';
export const FLOOR = '10';
export const BELOW_FLOOR = '5';

const LIFECYCLE_ACTIONS = [
  'wallet.deposit.detected',
  'wallet.deposit.failed',
  'wallet.deposit.below_minimum',
];

export type DepositEvent = Extract<PaymentWebhookEvent, { kind: 'deposit' }>;
export type StatusEvent = Extract<PaymentWebhookEvent, { kind: 'deposit_status' }>;
type AssetSeed = { network: string; minDeposit: string; depositEnabled?: boolean };

export const withoutNetwork = <T extends { network?: string }>({ network: _network, ...rest }: T) =>
  rest;

const uniqueCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

export function bootDepositLifecycle() {
  let db: TestDb;
  let testApp: TestApp;
  let admin: TestClient;

  beforeAll(async () => {
    db = await setupTestDb();
    testApp = await bootTestApp({
      plugins: [
        ...(await loadExtensions()),
        { id: 'testing-payment-webhook', path: paymentPluginPath },
        { id: 'test-wallet-reconciliation-config', path: reconciliationConfigPluginPath },
      ],
      databaseUrl: db.url,
    });
    await seedMinimal(testApp.container, { playerCount: 0 });
    admin = await asAdmin(testApp.app);
  }, 60_000);

  afterAll(async () => {
    await testApp?.close();
    await db?.dispose();
  });

  const drizzle = () => testApp.container.get(DRIZZLE).db;
  const app = () => testApp;
  const adminClient = () => admin;

  async function updateAsset(
    currency: string,
    network: string,
    changes: { minDeposit?: string; depositEnabled?: boolean },
  ) {
    const res = await admin.request(`/wallet/admin/assets/${currency}/${network}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(changes),
    });
    expect(res.status).toBe(200);
  }

  const setMinDeposit = (currency: string, minDeposit: string, network = NETWORK) =>
    updateAsset(currency, network, { minDeposit });

  async function createAsset(currency: string, network: string, minDeposit: string) {
    const res = await admin.post('/wallet/admin/assets', {
      currency,
      network,
      minDeposit,
      providerAssetId: `${currency}-${network}`,
      minWithdrawal: '1',
      withdrawalFee: '0',
    });
    expect(res.status).toBe(200);
  }

  async function issueAddress(client: TestClient, currency: string, network: string) {
    const res = await client.post('/wallet/deposits/address', { currency, network });
    expect(res.status).toBe(200);
    return ((await res.json()) as { address: string }).address;
  }

  async function withFailingTrigger(
    { table, when }: { table: string; when: string },
    body: () => Promise<void>,
  ) {
    const name = `fail_${randomUUID().replaceAll('-', '')}`;
    await drizzle().execute(
      sql.raw(`create function ${name}() returns trigger language plpgsql as $$ begin
        if ${when} then
          raise exception 'forced failure';
        end if;
        return new;
      end $$`),
    );
    await drizzle().execute(
      sql.raw(
        `create trigger ${name} before insert on ${table} for each row execute function ${name}()`,
      ),
    );
    try {
      await body();
    } finally {
      await drizzle().execute(sql.raw(`drop trigger ${name} on ${table}`));
      await drizzle().execute(sql.raw(`drop function ${name}()`));
    }
  }

  async function addCurrencyOnSameAddress(player: {
    client: TestClient;
    userId: string;
    address: string;
  }) {
    const currency = uniqueCurrency();
    await createAsset(currency, NETWORK, FLOOR);
    await drizzle().insert(exchangeRateQuote).values({
      baseCurrency: currency,
      quoteCurrency: 'USD',
      rate: '1',
      providerAsOf: new Date(),
    });
    await issueAddress(player.client, currency, NETWORK);
    await drizzle()
      .update(walletDepositAddress)
      .set({ address: player.address })
      .where(
        and(
          eq(walletDepositAddress.userId, player.userId),
          eq(walletDepositAddress.currency, currency),
        ),
      );
    return currency;
  }

  async function setup({
    assets = [{ network: NETWORK, minDeposit: FLOOR }],
    addressNetwork = NETWORK,
    tag,
    rated = true,
  }: {
    assets?: readonly AssetSeed[];
    addressNetwork?: string | null;
    tag?: string;
    rated?: boolean;
  } = {}) {
    const currency = uniqueCurrency();
    for (const asset of assets) {
      await createAsset(currency, asset.network, asset.minDeposit);
    }
    if (rated) {
      await drizzle().insert(exchangeRateQuote).values({
        baseCurrency: currency,
        quoteCurrency: 'USD',
        rate: '1',
        providerAsOf: new Date(),
      });
    }
    const { client, userId, playerId } = await registerAndMaterializePlayer(testApp, {
      email: `deposit-lifecycle-${randomUUID()}@e2e.test`,
    });
    const [firstAsset] = assets;
    const issuedNetwork =
      assets.find((asset) => asset.network === addressNetwork)?.network ?? firstAsset!.network;
    const address = await issueAddress(client, currency, issuedNetwork);
    for (const asset of assets) {
      if (asset.depositEnabled === false) {
        await updateAsset(currency, asset.network, { depositEnabled: false });
      }
    }
    if (tag !== undefined || addressNetwork !== issuedNetwork) {
      await drizzle()
        .update(walletDepositAddress)
        .set({ network: addressNetwork, ...(tag === undefined ? {} : { tag }) })
        .where(eq(walletDepositAddress.userId, userId));
    }
    const deposit = (overrides: Partial<DepositEvent> = {}): DepositEvent => ({
      kind: 'deposit',
      address,
      network: NETWORK,
      amount: FLOOR,
      currency,
      txHash: `hash-${randomUUID()}`,
      externalId: randomUUID(),
      ...overrides,
    });
    const status = (
      value: StatusEvent['status'],
      overrides: Partial<StatusEvent> = {},
    ): StatusEvent => ({
      kind: 'deposit_status',
      status: value,
      address,
      network: NETWORK,
      amount: FLOOR,
      currency,
      externalId: randomUUID(),
      ...overrides,
    });
    return { client, userId, playerId, currency, address, deposit, status };
  }

  const deliver = (event: unknown, signature?: string) => {
    const rawBody = JSON.stringify(event);
    return testApp.app.request('/wallet/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [TEST_PAYMENT_SIGNATURE_HEADER]: signature ?? signTestPaymentWebhook(rawBody),
      },
      body: rawBody,
    });
  };

  const auditRows = (externalId: string) =>
    drizzle()
      .select()
      .from(auditLog)
      .where(
        and(
          inArray(auditLog.action, LIFECYCLE_ACTIONS),
          sql`${auditLog.after}->>'externalId' = ${externalId}`,
        ),
      );

  const auditTrailOldestFirst = async (externalId: string) =>
    (await auditRows(externalId))
      .sort((a, b) => a.seq - b.seq)
      .map((row) => row.action.replace('wallet.deposit.', ''));

  const guardRows = (externalId: string) =>
    drizzle()
      .select()
      .from(walletDepositStatusEvent)
      .where(eq(walletDepositStatusEvent.externalId, externalId));

  const ledgerRows = (externalId: string) =>
    drizzle()
      .select()
      .from(walletTransaction)
      .where(eq(walletTransaction.providerRefId, externalId));

  const findings = (externalId: string) =>
    drizzle()
      .select()
      .from(walletReconciliationFinding)
      .where(eq(walletReconciliationFinding.externalId, externalId));

  async function balanceOf(userId: string, currency: string) {
    const [row] = await drizzle()
      .select({ amount: walletBalance.amount })
      .from(walletBalance)
      .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
      .where(and(eq(wallet.userId, userId), eq(walletBalance.currency, currency)));
    return Number(row?.amount ?? 0);
  }

  async function reconcile(events: PaymentWebhookEvent[]) {
    setTestPaymentTransactions(events);
    const res = await admin.post('/wallet/reconciliation/run', {});
    expect(res.status).toBe(200);
    const { runId } = (await res.json()) as { runId: string };
    return vi.waitFor(
      async () => {
        const [run] = await drizzle()
          .select({ status: walletJobRun.status, summary: walletJobRun.summary })
          .from(walletJobRun)
          .where(eq(walletJobRun.runId, runId));
        expect(run?.status).toBe('completed');
        return run!;
      },
      { timeout: 20_000, interval: 100 },
    );
  }

  return {
    app,
    drizzle,
    adminClient,
    issueAddress,
    addCurrencyOnSameAddress,
    withFailingTrigger,
    setMinDeposit,
    setup,
    deliver,
    auditRows,
    auditTrailOldestFirst,
    guardRows,
    ledgerRows,
    findings,
    balanceOf,
    reconcile,
  };
}

export type DepositPlayer = Awaited<ReturnType<ReturnType<typeof bootDepositLifecycle>['setup']>>;
