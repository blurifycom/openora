import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  DEFAULT_PAYMENT_PROVIDER,
  IDENTITY_READER,
  type PaymentWebhookEvent,
} from '@openora/core/contracts';
import { DRIZZLE, EVENT_BUS, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { AuditService } from '@openora/core/audit/server';
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
const SECOND_VENDOR = 'second-vendor';
const FLOOR = '10';
const BELOW_FLOOR = '5';

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

describe('a status event racing the confirmed deposit of the same transfer', () => {
  const ROUNDS = 3;

  async function race(make: (p: Player) => [{ externalId: string }, unknown]) {
    const player = await setup();
    const [first, second] = make(player);
    const responses = await Promise.all([deliver(first), deliver(second)]);
    expect(responses.map((res) => res.status)).toEqual([200, 200]);
    return { player, externalId: first.externalId };
  }

  it('credits once whichever order the two commit in, and never audits a status after the credit', async () => {
    const kinds: Array<'detected' | 'failed'> = ['detected', 'failed'];
    for (let round = 0; round < ROUNDS; round += 1) {
      for (const kind of kinds) {
        const { player, externalId } = await race((p) => {
          const confirmed = p.deposit();
          return [p.status(kind, { externalId: confirmed.externalId }), confirmed];
        });
        expect(await ledgerRows(externalId)).toHaveLength(1);
        expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
        // Either the status won the lock and was audited once, or the credit won and it left nothing.
        expect(await auditTrail(externalId)).toEqual(
          (await guardRows(externalId)).length === 1 ? [kind] : [],
        );
      }
    }
  });

  it('keeps detected before failed when the two race', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { externalId } = await race((p) => {
        const failed = p.status('failed');
        return [failed, { ...failed, status: 'detected' }];
      });
      const trail = await auditTrail(externalId);
      expect(['failed', 'detected,failed']).toContain(trail.join(','));
      expect(await guardRows(externalId)).toHaveLength(trail.length);
    }
  });

  it('never both credits and refuses one transfer when a below-minimum and an at-floor delivery race', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { player, externalId } = await race((p) => {
        const under = p.deposit({ amount: BELOW_FLOOR });
        return [under, { ...under, amount: FLOOR }];
      });
      const credited = (await ledgerRows(externalId)).length;
      const refused = (await auditTrail(externalId)).length;
      expect(credited + refused).toBe(1);
      expect(await balanceOf(player.userId, player.currency)).toBe(credited ? Number(FLOOR) : 0);
    }
  });

  it('audits failed before below_minimum, never after, when the two race', async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { player, externalId } = await race((p) => {
        const under = p.deposit({ amount: BELOW_FLOOR });
        return [under, p.status('failed', { externalId: under.externalId })];
      });
      const trail = await auditTrail(externalId);
      expect(['below_minimum', 'failed,below_minimum']).toContain(trail.join(','));
      expect(await ledgerRows(externalId)).toHaveLength(0);
      expect(await balanceOf(player.userId, player.currency)).toBe(0);
    }
  });
});

describe('the same transfer id under two vendors', () => {
  it('keeps each vendor’s verdicts apart and credits each its own deposit', async () => {
    const first = await setup();
    const second = await setup();
    await drizzle()
      .update(walletDepositAddress)
      .set({ providerName: SECOND_VENDOR })
      .where(eq(walletDepositAddress.userId, second.userId));
    const externalId = randomUUID();

    for (const player of [first, second]) {
      await deliver(player.deposit({ externalId, amount: BELOW_FLOOR }));
      await deliver(player.status('detected', { externalId }));
    }

    expect(
      (await guardRows(externalId)).map((row) => `${row.providerName}/${row.status}`).sort(),
    ).toEqual(
      [`${DEFAULT_PAYMENT_PROVIDER}/below_minimum`, `${SECOND_VENDOR}/below_minimum`].sort(),
    );
    const audited = await auditRows(externalId);
    expect(audited.map((row) => row.resourceId).sort()).toEqual(
      [first.playerId, second.playerId].sort(),
    );
    expect(await ledgerRows(externalId)).toHaveLength(0);

    const sharedAtFloor = randomUUID();
    await deliver(first.deposit({ externalId: sharedAtFloor }));
    await deliver(second.deposit({ externalId: sharedAtFloor }));
    expect((await ledgerRows(sharedAtFloor)).map((row) => row.providerName).sort()).toEqual(
      [DEFAULT_PAYMENT_PROVIDER, SECOND_VENDOR].sort(),
    );
  });
});

describe('an amount the vendor should never send', () => {
  it.each(['', '-5', '1e3', 'abc', '0x1', '15.5.5', 'NaN'])(
    'credits nothing and moves no balance for %j',
    async (amount) => {
      const player = await setup();
      const event = player.deposit({ amount });

      await deliver(event);
      await deliver(event);

      expect(await ledgerRows(event.externalId)).toHaveLength(0);
      expect(await balanceOf(player.userId, player.currency)).toBe(0);
      expect(await findings(event.externalId)).toHaveLength(0);
    },
  );
});

describe('a status event the contract does not describe', () => {
  it.each([{ status: 'pending' }, { status: undefined }, { externalId: undefined }])(
    'writes no guard or audit row for %j',
    async (override) => {
      const player = await setup();
      const event = { ...player.status('detected'), ...override };

      await deliver(event);

      expect(await guardRows(event.externalId ?? '')).toHaveLength(0);
      expect(await auditRows(event.externalId ?? '')).toHaveLength(0);
      expect(await balanceOf(player.userId, player.currency)).toBe(0);
    },
  );
});

describe('currency and network casing', () => {
  it('finds the floor whatever the case of the currency the vendor reports', async () => {
    const player = await setup();
    const under = player.deposit({ amount: BELOW_FLOOR, currency: player.currency.toLowerCase() });
    const atFloor = player.deposit({ currency: player.currency.toLowerCase() });

    await deliver(under);
    await deliver(atFloor);

    expect(await auditTrail(under.externalId)).toEqual(['below_minimum']);
    expect(await ledgerRows(under.externalId)).toHaveLength(0);
    expect(await ledgerRows(atFloor.externalId)).toHaveLength(1);
    expect(await balanceOf(player.userId, player.currency)).toBe(Number(FLOOR));
  });

  it('finds the floor whatever the case of the network the address was issued on', async () => {
    const player = await setup();
    await drizzle()
      .update(walletDepositAddress)
      .set({ network: NETWORK.toLowerCase() })
      .where(eq(walletDepositAddress.userId, player.userId));
    const { network: _network, ...event } = player.deposit({ amount: BELOW_FLOOR });

    await deliver(event);

    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });
});

describe('a floor of zero', () => {
  it('refuses nothing that is positive and still credits it', async () => {
    const player = await setup({ minDeposit: '0' });
    const event = player.deposit({ amount: '0.000000000000000001' });

    await deliver(event);

    expect(await ledgerRows(event.externalId)).toHaveLength(1);
    expect(await auditTrail(event.externalId)).toEqual([]);
  });
});

describe('the guard row and the audit row', () => {
  it('commit together: a forced audit failure leaves no guard row, and the retry audits', async () => {
    const player = await setup();
    const failed = player.status('failed');
    const belowMinimum = player.deposit({ amount: BELOW_FLOOR });
    const failAudit = `fail_audit_${randomUUID().replaceAll('-', '')}`;
    await drizzle().execute(
      sql.raw(`create function ${failAudit}() returns trigger language plpgsql as $$ begin
        if new.action in ('wallet.deposit.failed', 'wallet.deposit.below_minimum') then
          raise exception 'forced audit failure';
        end if;
        return new;
      end $$`),
    );
    await drizzle().execute(
      sql.raw(
        `create trigger ${failAudit} before insert on audit_log for each row execute function ${failAudit}()`,
      ),
    );
    try {
      const refused = await Promise.all([deliver(failed), deliver(belowMinimum)]);
      expect(refused.map((res) => res.ok)).toEqual([false, false]);
      for (const { externalId } of [failed, belowMinimum]) {
        expect(await guardRows(externalId)).toHaveLength(0);
        expect(await auditRows(externalId)).toHaveLength(0);
      }
      expect(await ledgerRows(belowMinimum.externalId)).toHaveLength(0);
    } finally {
      await drizzle().execute(sql.raw(`drop trigger ${failAudit} on audit_log`));
      await drizzle().execute(sql.raw(`drop function ${failAudit}()`));
    }

    const retried = await Promise.all([deliver(failed), deliver(belowMinimum)]);

    expect(retried.map((res) => res.status)).toEqual([200, 200]);
    expect(await auditTrail(failed.externalId)).toEqual(['failed']);
    expect(await auditTrail(belowMinimum.externalId)).toEqual(['below_minimum']);
    expect(await guardRows(failed.externalId)).toHaveLength(1);
    expect(await guardRows(belowMinimum.externalId)).toHaveLength(1);
  });
});

describe('reconciliation, beyond a plain below-minimum deposit', () => {
  it('leaves a credited deposit alone when the minimum has since risen and a late failure is polled', async () => {
    const player = await setup();
    const credited = player.deposit();
    await deliver(credited);
    await drizzle()
      .update(walletAsset)
      .set({ minDeposit: '100' })
      .where(eq(walletAsset.currency, player.currency));

    await reconcile([credited, player.status('failed', { externalId: credited.externalId })]);

    expect(await ledgerRows(credited.externalId)).toHaveLength(1);
    expect(await findings(credited.externalId)).toHaveLength(0);
    expect(await auditRows(credited.externalId)).toHaveLength(0);
  });

  it('still files a finding for a below-minimum deposit no single player can be named for', async () => {
    const player = await setup();
    const unknownAddress = player.deposit({
      address: `unknown-${randomUUID()}`,
      amount: BELOW_FLOOR,
    });

    await reconcile([unknownAddress]);

    expect(await findings(unknownAddress.externalId)).toHaveLength(1);
    expect(await auditRows(unknownAddress.externalId)).toHaveLength(0);
    expect(await guardRows(unknownAddress.externalId)).toHaveLength(0);
  });

  it('settles a below-minimum deposit seen by the poll before the webhook with one audit row', async () => {
    const player = await setup();
    const event = player.deposit({ amount: BELOW_FLOOR });

    await reconcile([event]);
    const res = await deliver(event);

    expect(res.status).toBe(200);
    expect(await auditTrail(event.externalId)).toEqual(['below_minimum']);
    expect(await findings(event.externalId)).toHaveLength(0);
    expect(await ledgerRows(event.externalId)).toHaveLength(0);
  });
});

describe('the audit chain after all of the above', () => {
  it('still verifies end to end', async () => {
    const audit = new AuditService(
      testApp.container.get(DRIZZLE),
      testApp.container.get(EVENT_BUS),
      testApp.container.get(IDENTITY_READER),
    );

    expect(await audit.verifyChain()).toEqual({ valid: true });
  });
});
