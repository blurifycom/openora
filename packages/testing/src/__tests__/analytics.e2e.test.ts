import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  setupTestDb,
  bootTestApp,
  registerPlayer,
  asPlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function deposit(client: TestClient, amount: string, currency = 'USD') {
  const res = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount,
    currency,
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

async function walletIdFor(
  container: Container<CoreTokenCatalog>,
  userId: string,
): Promise<string> {
  const [row] = await container
    .get(DRIZZLE)
    .db.select()
    .from(wallet)
    .where(eq(wallet.userId, userId));
  if (!row) {
    throw new Error(`no wallet row for user ${userId}`);
  }
  return row.id;
}

async function insertTransaction(
  container: Container<CoreTokenCatalog>,
  walletId: string,
  type: 'bonus' | 'bet' | 'win',
  amount: string,
  currency = 'USD',
) {
  await container
    .get(DRIZZLE)
    .db.insert(walletTransaction)
    .values({ id: randomUUID(), walletId, type, amount, currency, status: 'completed' });
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

describe('analytics e2e', () => {
  it('breaks financial summary down by currency and rail, computed only from completed transactions', async () => {
    const email = `financial-e2e-${randomUUID()}@example.com`;
    const userId = await registerPlayer(app, { email });
    const client = await asPlayer(app.app, { email });
    await deposit(client, '500');
    await deposit(client, '120');

    const walletId = await walletIdFor(app.container, userId);
    await insertTransaction(app.container, walletId, 'bonus', '30');

    const res = await admin.get('/analytics/financial/summary?currency=USD');
    expect(res.status).toBe(200);
    const body = await readJson(res);

    const usdDeposits = body.deposits.find(
      (d: { currency: string; rail: string | null }) => d.currency === 'USD' && d.rail === 'fiat',
    );
    expect(usdDeposits).toBeDefined();
    expect(Number(usdDeposits.total)).toBeGreaterThanOrEqual(620);

    const usdBonus = body.bonusCost.find((b: { currency: string }) => b.currency === 'USD');
    expect(Number(usdBonus.total)).toBeGreaterThanOrEqual(30);
  });

  it('computes a GGR trend from completed bet/win transactions only', async () => {
    const email = `ggr-e2e-${randomUUID()}@example.com`;
    const userId = await registerPlayer(app, { email });
    const client = await asPlayer(app.app, { email });
    await deposit(client, '1000');
    const walletId = await walletIdFor(app.container, userId);
    await insertTransaction(app.container, walletId, 'bet', '100');
    await insertTransaction(app.container, walletId, 'win', '40');

    const today = new Date().toISOString().slice(0, 10);
    const res = await admin.get(
      `/analytics/financial/ggr?currency=USD&dateFrom=${today}T00:00:00.000Z&dateTo=${today}T23:59:59.999Z&granularity=day`,
    );
    expect(res.status).toBe(200);
    const body = await readJson(res);

    const usdSeries = body.find((s: { currency: string }) => s.currency === 'USD');
    expect(usdSeries).toBeDefined();
    const total = usdSeries.points.reduce(
      (sum: number, p: { ggr: string }) => sum + Number(p.ggr),
      0,
    );
    expect(total).toBeGreaterThanOrEqual(60);
  });

  it('produces a strictly nested conversion funnel for a fresh registration cohort', async () => {
    const verifiedDepositorBettorEmail = `funnel-a-${randomUUID()}@example.com`;
    const registeredOnlyEmail = `funnel-b-${randomUUID()}@example.com`;

    const userIdA = await registerPlayer(app, { email: verifiedDepositorBettorEmail });
    await registerPlayer(app, { email: registeredOnlyEmail, verifyEmail: false });

    const clientA = await asPlayer(app.app, { email: verifiedDepositorBettorEmail });
    await deposit(clientA, '50');
    const walletIdA = await walletIdFor(app.container, userIdA);
    await insertTransaction(app.container, walletIdA, 'bet', '10');

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const res = await admin.get(`/analytics/funnel/conversion?dateFrom=${from}&dateTo=${to}`);
    expect(res.status).toBe(200);
    const stages = (await readJson(res)) as Array<{
      stage: string;
      count: number;
      dropOffRate: number | null;
    }>;

    const byStage = new Map(stages.map((s) => [s.stage, s]));
    const registered = byStage.get('registered');
    const emailVerified = byStage.get('email_verified');
    const firstDeposit = byStage.get('first_deposit');
    const firstBet = byStage.get('first_bet');
    expect(registered).toBeDefined();
    expect(emailVerified).toBeDefined();
    expect(firstDeposit).toBeDefined();
    expect(firstBet).toBeDefined();

    expect(registered?.count).toBeGreaterThanOrEqual(2);
    expect(emailVerified?.count).toBeGreaterThanOrEqual(1);
    expect(emailVerified?.count).toBeLessThanOrEqual(registered?.count ?? 0);
    expect(firstDeposit?.count).toBeLessThanOrEqual(emailVerified?.count ?? 0);
    expect(firstBet?.count).toBeLessThanOrEqual(firstDeposit?.count ?? 0);
    expect(firstBet?.count).toBeGreaterThanOrEqual(1);
    expect(registered?.dropOffRate).toBeNull();
  });

  it('rejects an analytics read from a non-admin caller', async () => {
    const email = `no-access-${randomUUID()}@example.com`;
    await registerPlayer(app, { email });
    const player = await asPlayer(app.app, { email });
    const res = await player.get('/analytics/financial/summary');
    expect(res.status).toBe(403);
  });
});
