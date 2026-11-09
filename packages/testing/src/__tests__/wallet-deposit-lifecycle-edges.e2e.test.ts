import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { DEFAULT_PAYMENT_PROVIDER, type PaymentWebhookEvent } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { exchangeRateQuote } from '@openora/core/fx/schema/exchange-rate';
import {
  wallet,
  walletAsset,
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
} from '../index.js';
import {
  setTestPaymentTransactions,
  signTestPaymentWebhook,
  TEST_PAYMENT_SIGNATURE_HEADER,
} from '../test-payment-webhook-plugin.js';

// The webhook route allows 120 requests a minute per client, and this file shares one app:
// keep the total number of deliveries well under that.
const paymentPluginPath = fileURLToPath(
  new URL('../test-payment-webhook-plugin.ts', import.meta.url),
);
const reconciliationConfigPluginPath = fileURLToPath(
  new URL('./fixtures/test-wallet-reconciliation-config-plugin.ts', import.meta.url),
);

const LIFECYCLE_ACTIONS = [
  'wallet.deposit.detected',
  'wallet.deposit.failed',
  'wallet.deposit.below_minimum',
];
const NETWORK = 'TESTCHAIN';
const FLOOR = '10';

type DepositEvent = Extract<PaymentWebhookEvent, { kind: 'deposit' }>;
type StatusEvent = Extract<PaymentWebhookEvent, { kind: 'deposit_status' }>;

let db: TestDb;
let testApp: TestApp;
let admin: TestClient;

const drizzle = () => testApp.container.get(DRIZZLE).db;

const uniqueCurrency = () =>
  Array.from(randomBytes(8), (byte) => String.fromCharCode(65 + (byte % 26))).join('');

async function setup({ minDeposit = FLOOR }: { minDeposit?: string } = {}) {
  const currency = uniqueCurrency();
  await drizzle()
    .insert(walletAsset)
    .values({
      currency,
      network: NETWORK,
      minDeposit,
      providerAssetId: `${currency}-${NETWORK}`,
      minWithdrawal: '1',
      withdrawalFee: '0',
    });
  await drizzle().insert(exchangeRateQuote).values({
    baseCurrency: currency,
    quoteCurrency: 'USD',
    rate: '1',
    providerAsOf: new Date(),
  });
  const { userId, playerId } = await registerAndMaterializePlayer(testApp, {
    email: `deposit-hostile-${randomUUID()}@e2e.test`,
  });
  const address = `addr-${randomUUID()}`;
  await drizzle().insert(walletDepositAddress).values({
    userId,
    currency,
    network: NETWORK,
    address,
    providerName: DEFAULT_PAYMENT_PROVIDER,
  });
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
  return { userId, playerId, currency, address, deposit, status };
}

type Player = Awaited<ReturnType<typeof setup>>;

const deliver = (event: unknown) => {
  const rawBody = JSON.stringify(event);
  return testApp.app.request('/wallet/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      [TEST_PAYMENT_SIGNATURE_HEADER]: signTestPaymentWebhook(rawBody),
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

// Oldest first, by the audit chain's own sequence.
const auditTrail = async (externalId: string) =>
  (await auditRows(externalId))
    .sort((a, b) => a.seq - b.seq)
    .map((row) => row.action.replace('wallet.deposit.', ''));

const guardRows = (externalId: string) =>
  drizzle()
    .select()
    .from(walletDepositStatusEvent)
    .where(eq(walletDepositStatusEvent.externalId, externalId));

const ledgerRows = (externalId: string) =>
  drizzle().select().from(walletTransaction).where(eq(walletTransaction.providerRefId, externalId));

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
  await vi.waitFor(
    async () => {
      const [run] = await drizzle()
        .select({ status: walletJobRun.status })
        .from(walletJobRun)
        .where(eq(walletJobRun.runId, runId));
      expect(run?.status).toBe('completed');
    },
    { timeout: 20_000, interval: 100 },
  );
}

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

async function withdrawalInFlight({ userId, currency }: Player) {
  const [record] = await drizzle()
    .select({ id: wallet.id })
    .from(wallet)
    .where(eq(wallet.userId, userId));
  const externalId = randomUUID();
  await drizzle().insert(walletTransaction).values({
    walletId: record!.id,
    type: 'withdrawal',
    amount: '1',
    currency,
    status: 'processing',
    direction: 'debit',
    rail: 'crypto',
    network: NETWORK,
    providerName: DEFAULT_PAYMENT_PROVIDER,
    providerRefId: externalId,
  });
  return externalId;
}

const outboxPayloads = async (topic: string, transactionId: string) =>
  (
    await drizzle().execute(
      sql`select payload from event_outbox where topic = ${topic} and payload->>'transactionId' = ${transactionId}`,
    )
  ).rows.map((row) => row['payload'] as Record<string, string>);

describe('a malformed status event that cannot name a deposit to record', () => {
  it('answers 200 and writes nothing when the address is nobody’s', async () => {
    const player = await setup();
    const event = player.status('detected', {
      address: `unknown-${randomUUID()}`,
      amount: 'abc',
    });

    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await guardRows(event.externalId)).toHaveLength(0);
    expect(await auditRows(event.externalId)).toHaveLength(0);
    expect(await findings(event.externalId)).toHaveLength(0);
  });

  it('is a no-op for a deposit that is already credited', async () => {
    const player = await setup();
    const credited = player.deposit();
    await deliver(credited);

    const res = await deliver(
      player.status('failed', { externalId: credited.externalId, amount: 'abc' }),
    );

    expect(res.status).toBe(200);
    expect(await ledgerRows(credited.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await auditRows(credited.externalId)).toHaveLength(0);
  });
});

describe('an amount with more decimals than the ledger keeps, below the floor', () => {
  it('answers an error with nothing recorded, and the corrected amount credits on retry', async () => {
    const player = await setup();
    const externalId = randomUUID();

    const refused = await deliver(player.deposit({ externalId, amount: '9.9999999999999999999' }));

    expect(refused.status).toBe(500);
    expect(await guardRows(externalId)).toHaveLength(0);
    expect(await auditRows(externalId)).toHaveLength(0);

    const retried = await deliver(player.deposit({ externalId, amount: '15' }));

    expect(retried.status).toBe(200);
    expect(await ledgerRows(externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(15);
  });
});

describe('the poll, with a malformed status event in the batch', () => {
  it('skips it, audits the good one, moves the withdrawal and finishes the run', async () => {
    const player = await setup();
    await deliver(player.deposit());
    const withdrawalId = await withdrawalInFlight(player);
    const badAmount = player.status('detected', { amount: 'abc' });
    const noId = player.status('failed', { externalId: '' });
    const good = player.status('detected');

    await reconcile([
      badAmount,
      noId,
      good,
      { kind: 'withdrawal', externalId: withdrawalId, status: 'completed' },
    ]);

    expect(await auditRows(badAmount.externalId)).toHaveLength(0);
    expect(await guardRows('')).toHaveLength(0);
    expect(await auditTrail(good.externalId)).toEqual(['detected']);
    expect((await ledgerRows(withdrawalId)).map((row) => row.status)).toEqual(['completed']);
  });
});

describe('a deposit credited after the vendor reported it failed', () => {
  it('writes the completed event in the credit’s own transaction, beside the failed audit row', async () => {
    const player = await setup();
    const failed = player.status('failed');

    await deliver(failed);
    const res = await deliver(player.deposit({ externalId: failed.externalId }));

    expect(res.status).toBe(200);
    const [credit] = await ledgerRows(failed.externalId);
    expect(credit?.status).toBe('completed');
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
    expect(await auditTrail(failed.externalId)).toEqual(['failed']);
    expect(await outboxPayloads('wallet.deposit.completed', credit!.id)).toEqual([
      expect.objectContaining({ userId: player.userId, amount: FLOOR, currency: player.currency }),
    ]);
  });

  it('rolls the credit back when that event cannot be written, and credits on the retry', async () => {
    const player = await setup();
    const event = player.deposit();
    const failEvent = `fail_outbox_${randomUUID().replaceAll('-', '')}`;
    await drizzle().execute(
      sql.raw(`create function ${failEvent}() returns trigger language plpgsql as $$ begin
        if new.topic = 'wallet.deposit.completed' and new.payload->>'currency' = '${player.currency}' then
          raise exception 'forced outbox failure';
        end if;
        return new;
      end $$`),
    );
    await drizzle().execute(
      sql.raw(
        `create trigger ${failEvent} before insert on event_outbox for each row execute function ${failEvent}()`,
      ),
    );
    try {
      const refused = await deliver(event);

      expect(refused.ok).toBe(false);
      expect(await ledgerRows(event.externalId)).toHaveLength(0);
      expect(await balanceOf(player.userId, player.currency)).toBe(0);
    } finally {
      await drizzle().execute(sql.raw(`drop trigger ${failEvent} on event_outbox`));
      await drizzle().execute(sql.raw(`drop function ${failEvent}()`));
    }

    const retried = await deliver(event);

    expect(retried.status).toBe(200);
    const [credit] = await ledgerRows(event.externalId);
    expect(await outboxPayloads('wallet.deposit.completed', credit!.id)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });
});

describe('a confirmed deposit on an address nobody holds, after status events for it', () => {
  it('files the finding with the confirmed amount, not a status event’s', async () => {
    const player = await setup();
    const address = `unknown-${randomUUID()}`;
    const externalId = randomUUID();

    await deliver(player.status('detected', { address, externalId, amount: '3' }));
    await deliver(player.status('failed', { address, externalId, amount: '4' }));
    const res = await deliver(player.deposit({ address, externalId, amount: '12.5' }));

    expect(res.status).toBe(200);
    const filed = await findings(externalId);
    expect(filed.map((finding) => finding.kind)).toEqual(['unattributed_deposit']);
    expect(Number(filed[0]?.amount)).toBe(12.5);
    expect(await auditRows(externalId)).toHaveLength(0);
  });
});

describe('withdrawal webhook events', () => {
  it('move the withdrawal transaction through the double', async () => {
    const player = await setup();
    await deliver(player.deposit());
    const completing = await withdrawalInFlight(player);
    const failing = await withdrawalInFlight(player);

    await deliver({ kind: 'withdrawal', externalId: completing, status: 'processing' });
    expect((await ledgerRows(completing)).map((row) => row.status)).toEqual(['processing']);

    const txHash = `hash-${randomUUID()}`;
    await deliver({ kind: 'withdrawal', externalId: completing, status: 'completed', txHash });
    await deliver({ kind: 'withdrawal', externalId: failing, status: 'failed' });

    expect((await ledgerRows(completing)).map((row) => [row.status, row.txHash])).toEqual([
      ['completed', txHash],
    ]);
    expect((await ledgerRows(failing)).map((row) => row.status)).toEqual(['failed']);
    expect(await guardRows(completing)).toHaveLength(0);
  });
});
