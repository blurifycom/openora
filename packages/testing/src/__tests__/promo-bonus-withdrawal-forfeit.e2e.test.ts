import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { BONUS_GRANTS } from '@openora/core/contracts';
import { promoGrant, promoWeight, promoWeightProfile } from '@openora/core/promo/schema/bonus';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let weightProfileId: string;

const drizzle = () => app.container.get(DRIZZLE).db;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function fundedPlayer() {
  const player = await registerAndMaterializePlayer(app, {
    email: `withdrawal-forfeit-${randomUUID()}@e2e.test`,
  });
  const res = await player.client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount: '500',
    currency: 'USD',
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
  return player;
}

async function grantBonus(userId: string, currency = 'USD') {
  const outcome = await drizzle().transaction((tx) =>
    app.container.get(BONUS_GRANTS).grant(tx, {
      userId,
      currency,
      amount: '100',
      source: 'deposit',
      sourceRef: randomUUID(),
      actor: { type: 'system' },
      terms: { wageringMultiplier: '5', expiryDays: 30, weightProfileId },
    }),
  );
  if (!outcome.ok) {
    throw new Error('grantBonus: grant was refused');
  }
  return outcome.grantId;
}

async function grantRow(id: string) {
  const [row] = await drizzle().select().from(promoGrant).where(eq(promoGrant.id, id));
  if (!row) {
    throw new Error('grantRow: query returned no row');
  }
  return row;
}

function requestWithdrawal(client: TestClient) {
  return client.post('/wallet/withdraw', {
    idempotencyKey: randomUUID(),
    amount: '50',
    currency: 'USD',
  });
}

async function auditActions(grantId: string, action: string) {
  const body = await readJson(
    await admin.get(`/audit/logs?resourceId=${grantId}&action=${action}&limit=50`),
  );
  return body.items as { action: string; actorType: string; actorId: string | null }[];
}

async function waitForLockWait() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await drizzle().execute<{ waiting: number }>(
      sql`select count(*)::int as waiting from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
    );
    if ((result.rows[0]?.waiting ?? 0) > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('no session ever waited on a row lock');
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

beforeEach(async () => {
  const [profile] = await drizzle()
    .insert(promoWeightProfile)
    .values({ name: `profile-${randomUUID()}` })
    .returning();
  if (!profile) {
    throw new Error('seed profile: query returned no row');
  }
  weightProfileId = profile.id;
  await drizzle().insert(promoWeight).values({
    profileId: weightProfileId,
    scope: 'default',
    scopeRef: null,
    contributionPercent: '100',
  });
});

describe('a withdrawal requested while a bonus is live', () => {
  it('has forfeited every bonus the player held by the time the request returns', async () => {
    const { client, userId } = await fundedPlayer();
    const usd = await grantBonus(userId, 'USD');
    const eur = await grantBonus(userId, 'EUR');

    const res = await requestWithdrawal(client);

    expect(res.status).toBe(200);
    const { transactionId } = await readJson(res);
    expect(await grantRow(usd)).toMatchObject({
      status: 'forfeited',
      forfeitReason: 'withdrawal_while_active',
      forfeitedBy: userId,
      forfeitNote: `withdrawal ${transactionId}`,
      bonusBalance: '0.000000000000000000',
    });
    expect((await grantRow(eur)).status).toBe('forfeited');
    expect(await readJson(await client.get('/promo/balance'))).toEqual([]);
    expect(await auditActions(usd, 'promo.bonus.forfeited')).toEqual([
      expect.objectContaining({ actorType: 'player', actorId: userId }),
    ]);
  });

  it('withdraws as usual for a player with no live bonus', async () => {
    const { client } = await fundedPlayer();

    const res = await requestWithdrawal(client);

    expect(res.status).toBe(200);
    expect((await readJson(res)).status).toBe('pending');
    expect((await readJson(await client.get('/wallet/balance'))).balance).toBe(
      '450.000000000000000000',
    );
  });

  it('keeps the bonus forfeited when the withdrawal is rejected', async () => {
    const { client, userId } = await fundedPlayer();
    const grantId = await grantBonus(userId);
    const { transactionId } = await readJson(await requestWithdrawal(client));

    const rejected = await admin.post(`/wallet/withdrawals/${transactionId}/reject`, {
      withdrawalId: transactionId,
      reason: 'e2e: rejected after a bonus forfeit',
    });

    expect(rejected.status).toBe(200);
    expect((await readJson(await client.get('/wallet/balance'))).balance).toBe(
      '500.000000000000000000',
    );
    expect((await grantRow(grantId)).status).toBe('forfeited');
    expect(await readJson(await client.get('/promo/balance'))).toEqual([]);
  });

  it('writes no refusal against the player when another path closed the bonus first', async () => {
    const { client, userId } = await fundedPlayer();
    const grantId = await grantBonus(userId);
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });

    const racer = drizzle().transaction(async (tx) => {
      await tx.select().from(promoGrant).where(eq(promoGrant.id, grantId)).for('update');
      await tx
        .update(promoGrant)
        .set({ status: 'expired', closedAt: new Date() })
        .where(eq(promoGrant.id, grantId));
      locked();
      await released;
    });
    await lockTaken;

    const withdrawal = requestWithdrawal(client);
    await waitForLockWait();
    release();
    await racer;
    const res = await withdrawal;

    expect(res.status).toBe(200);
    expect((await grantRow(grantId)).status).toBe('expired');
    expect(await auditActions(grantId, 'promo.bonus.forfeit_refused')).toEqual([]);
    expect(await auditActions(grantId, 'promo.bonus.forfeited')).toEqual([]);
  });
});
