import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import type { PaymentWebhookEvent } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import {
  DepositAddressSchema,
  WalletReconciliationFindingSchema,
} from '@openora/core/wallet/contract';
import {
  wallet,
  walletBalance,
  walletReconciliationFinding,
  walletTransaction,
} from '@openora/core/wallet/schema';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  registerAndMaterializePlayer,
  type E2e,
  type TestClient,
} from '../../index.js';
import {
  signTestPaymentWebhook,
  TEST_PAYMENT_SIGNATURE_HEADER,
} from '../../test-payment-webhook-plugin.js';

const pluginPath = (file: string) => fileURLToPath(new URL(file, import.meta.url));

export const NETWORK = 'TESTCHAIN';
export const MIN_DEPOSIT = '10';
export const RATE = '1.5';

export type DepositEvent = Extract<PaymentWebhookEvent, { kind: 'deposit' }>;
export type DepositStatusEvent = Extract<PaymentWebhookEvent, { kind: 'deposit_status' }>;

export type WalletE2e = E2e & { admin: TestClient };

export async function bootWalletE2e(): Promise<WalletE2e> {
  const e2e = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      { id: 'testing-payment-webhook', path: pluginPath('../../test-payment-webhook-plugin.ts') },
      { id: 'testing-deposit-hold', path: pluginPath('./test-deposit-hold-plugin.ts') },
    ],
  });
  try {
    return { ...e2e, admin: await asAdmin(e2e.app.app) };
  } catch (err) {
    await closeE2e(e2e);
    throw err;
  }
}

export const closeWalletE2e = (e2e: WalletE2e | undefined) => closeE2e(e2e ?? {});

const uniqueCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

export async function addAsset(
  admin: TestClient,
  currency: string,
  network: string,
  minDeposit = MIN_DEPOSIT,
  depositEnabled = true,
) {
  const created = await admin.post('/wallet/admin/assets', {
    currency,
    network,
    minDeposit,
    providerAssetId: `${currency}-${network}`,
    minWithdrawal: '1',
    withdrawalFee: '0',
  });
  if (created.status !== 200) {
    throw new Error(`asset create failed (${created.status}): ${await created.text()}`);
  }
  if (!depositEnabled) {
    const updated = await admin.put(`/wallet/admin/assets/${currency}/${network}`, {
      depositEnabled: false,
    });
    if (updated.status !== 200) {
      throw new Error(`asset update failed (${updated.status}): ${await updated.text()}`);
    }
  }
}

type ScenarioOptions = {
  minDeposit?: string;
  rated?: boolean;
  requestAddress?: boolean;
};

export async function newDepositScenario(
  { app, admin }: WalletE2e,
  { minDeposit = MIN_DEPOSIT, rated = true, requestAddress = true }: ScenarioOptions = {},
) {
  const db = app.container.get(DRIZZLE).db;
  const currency = uniqueCurrency();
  await addAsset(admin, currency, NETWORK, minDeposit);
  if (rated) {
    await db.insert(exchangeRateQuote).values({
      baseCurrency: currency,
      quoteCurrency: 'USD',
      rate: RATE,
      providerAsOf: new Date(),
    });
  }
  const player = await registerAndMaterializePlayer(app, {
    email: `deposit-${randomUUID()}@e2e.test`,
  });
  const address = requestAddress
    ? await requestDepositAddress(player.client, currency, NETWORK)
    : `addr-${player.userId}-${currency}`;
  const deposit = (overrides: Partial<DepositEvent> = {}): DepositEvent => ({
    kind: 'deposit',
    address,
    network: NETWORK,
    amount: minDeposit,
    currency,
    txHash: `hash-${randomUUID()}`,
    externalId: randomUUID(),
    ...overrides,
  });
  const status = (
    value: DepositStatusEvent['status'],
    overrides: Partial<DepositStatusEvent> = {},
  ): DepositStatusEvent => ({
    kind: 'deposit_status',
    status: value,
    address,
    network: NETWORK,
    amount: minDeposit,
    currency,
    externalId: randomUUID(),
    ...overrides,
  });
  return { ...player, currency, address, deposit, status };
}

export type DepositScenario = Awaited<ReturnType<typeof newDepositScenario>>;

export async function requestDepositAddress(
  client: TestClient,
  currency: string,
  network?: string,
) {
  const res = await client.post('/wallet/deposits/address', { currency, network });
  if (res.status !== 200) {
    throw new Error(`deposit address failed (${res.status}): ${await res.text()}`);
  }
  return DepositAddressSchema.parse(await res.json()).address;
}

export function deliverWebhook({ app }: WalletE2e, event: unknown, signature?: string) {
  const rawBody = JSON.stringify(event);
  return app.app.request('/wallet/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TEST_PAYMENT_SIGNATURE_HEADER]: signature ?? signTestPaymentWebhook(rawBody),
    },
    body: rawBody,
  });
}

export async function balanceOf({ app }: WalletE2e, userId: string, currency: string) {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(and(eq(wallet.userId, userId), eq(walletBalance.currency, currency)));
  return row?.amount ?? '0';
}

export const ledgerRows = ({ app }: WalletE2e, externalId: string) =>
  app.container
    .get(DRIZZLE)
    .db.select()
    .from(walletTransaction)
    .where(eq(walletTransaction.providerRefId, externalId));

export const findingsFor = ({ app }: WalletE2e, externalId: string) =>
  app.container
    .get(DRIZZLE)
    .db.select()
    .from(walletReconciliationFinding)
    .where(eq(walletReconciliationFinding.externalId, externalId));

export async function resolveFinding(
  client: TestClient,
  findingId: string,
  resolution: Record<string, unknown>,
) {
  const res = await client.post(`/wallet/reconciliation/${findingId}/resolve`, { resolution });
  return { status: res.status, body: (await res.json()) as unknown };
}

export const parseFinding = (body: unknown) => WalletReconciliationFindingSchema.parse(body);
