import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import { promoGrant, promoOptIn } from '@openora/core/promo/schema/bonus';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

const offerBody = (over: Record<string, unknown> = {}) => ({
  key: `offer-${randomUUID()}`,
  name: 'Sign-Up Bonus',
  status: 'active',
  currency: 'USD',
  matchPercent: '100',
  maxGrantAmount: '1000',
  minDeposit: '20',
  terms: { wageringMultiplier: '5', expiryDays: 30 },
  rules: { firstDepositOnly: false, excludedCountries: [] },
  requiresOptIn: true,
  ...over,
});

async function createOffer(over: Record<string, unknown> = {}) {
  const res = await admin.post('/backoffice/promo/offers', offerBody(over));
  if (res.status !== 200) {
    throw new Error(`createOffer failed (${res.status}): ${await res.text()}`);
  }
  return readJson(res);
}

async function deposit(client: TestClient, amount: string) {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

/** The grant is created by a job the deposit enqueues, so the assertion waits for it to land. */
async function waitFor<T>(read: () => Promise<T[]>, count: number): Promise<T[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const rows = await read();
    if (rows.length >= count) {
      return rows;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return read();
}

async function settled(userId: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 300));
  void userId;
}

const grantsOf = (userId: string) =>
  drizzle().select().from(promoGrant).where(eq(promoGrant.userId, userId));

const optInsOf = (userId: string) =>
  drizzle().select().from(promoOptIn).where(eq(promoOptIn.userId, userId));

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });

  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `offers-admin-${randomUUID()}@example.test`,
  });
  await drizzle().update(user).set({ role: 'admin' }).where(eq(user.id, userId));
  const [role] = await drizzle().select().from(adminRole).where(eq(adminRole.key, 'super-admin'));
  if (!role) {
    throw new Error('no seeded super-admin role');
  }
  await drizzle()
    .insert(adminRoleAssignment)
    .values({ userId, roleId: role.id })
    .onConflictDoNothing();
  admin = client;
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

describe('an admin configuring offers', () => {
  it('creates one and reads it back', async () => {
    const created = await createOffer({ name: 'Weekly Reload' });

    expect(created).toMatchObject({ name: 'Weekly Reload', status: 'active' });
    const listed = await readJson(await admin.get('/backoffice/promo/offers?status=active'));
    expect(listed.some((o: { id: string }) => o.id === created.id)).toBe(true);
  });

  it('refuses a second offer under the same key', async () => {
    const body = offerBody();
    await admin.post('/backoffice/promo/offers', body);

    const res = await admin.post('/backoffice/promo/offers', body);

    expect(res.status).toBe(409);
  });

  it('pauses an offer without touching a bonus already granted under it', async () => {
    const offer = await createOffer();
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `offers-live-${randomUUID()}@example.test`,
    });
    await client.post(`/promo/offers/${offer.id}/opt-in`, {});
    await deposit(client, '50');
    const [granted] = await waitFor(() => grantsOf(userId), 1);

    await admin.patch(`/backoffice/promo/offers/${offer.id}`, { status: 'paused' });

    const [after] = await grantsOf(userId);
    expect(after?.wageringRequired).toBe(granted?.wageringRequired);
    expect(after?.terms).toEqual(granted?.terms);
  });

  it('refuses a player reaching for the admin surface', async () => {
    const { client } = await registerAndMaterializePlayer(app, {
      email: `offers-player-${randomUUID()}@example.test`,
    });

    const res = await client.get('/backoffice/promo/offers');

    expect(res.status).toBe(403);
  });
});

describe('a player taking an offer', () => {
  it('sees the live offers with what their deposits have put toward each', async () => {
    const offer = await createOffer({ minDeposit: '20' });
    const { client } = await registerAndMaterializePlayer(app, {
      email: `offers-list-${randomUUID()}@example.test`,
    });

    const body = await readJson(await client.get('/promo/offers'));

    const listed = body.find((o: { id: string }) => o.id === offer.id);
    expect(listed).toMatchObject({ optedIn: false, accumulatedDeposit: '0' });
    expect(listed.wageringMultiplier).toBe('5');
  });

  it('takes it once, however many times they ask', async () => {
    const offer = await createOffer();
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `offers-twice-${randomUUID()}@example.test`,
    });

    await client.post(`/promo/offers/${offer.id}/opt-in`, {});
    await client.post(`/promo/offers/${offer.id}/opt-in`, {});

    expect(await optInsOf(userId)).toHaveLength(1);
  });

  it('is granted the match when the deposit meets the minimum', async () => {
    const offer = await createOffer({
      minDeposit: '20',
      matchPercent: '100',
      maxGrantAmount: '1000',
    });
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `offers-grant-${randomUUID()}@example.test`,
    });
    await client.post(`/promo/offers/${offer.id}/opt-in`, {});

    await deposit(client, '50');

    const grants = await waitFor(() => grantsOf(userId), 1);
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({
      grantedAmount: '50.000000000000000000',
      wageringRequired: '250.000000000000000000',
      offerId: offer.id,
    });
  });

  it('caps the grant at the offer ceiling', async () => {
    const offer = await createOffer({
      minDeposit: '20',
      matchPercent: '100',
      maxGrantAmount: '100',
    });
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `offers-cap-${randomUUID()}@example.test`,
    });
    await client.post(`/promo/offers/${offer.id}/opt-in`, {});

    await deposit(client, '5000');

    const [grant] = await waitFor(() => grantsOf(userId), 1);
    expect(grant?.grantedAmount).toBe('100.000000000000000000');
  });

  it('counts two deposits under the minimum toward it, and grants once', async () => {
    const offer = await createOffer({
      minDeposit: '100',
      matchPercent: '50',
      maxGrantAmount: '1000',
    });
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `offers-partial-${randomUUID()}@example.test`,
    });
    await client.post(`/promo/offers/${offer.id}/opt-in`, {});

    await deposit(client, '60');
    const [pending] = await waitFor(
      async () =>
        (await optInsOf(userId)).filter((o) => o.accumulatedDeposit !== '0.000000000000000000'),
      1,
    );
    expect(pending?.accumulatedDeposit).toBe('60.000000000000000000');
    expect(await grantsOf(userId)).toHaveLength(0);

    await deposit(client, '60');

    const grants = await waitFor(() => grantsOf(userId), 1);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.grantedAmount).toBe('60.000000000000000000');

    await deposit(client, '60');
    await settled(userId);
    expect(await grantsOf(userId)).toHaveLength(1);
  });

  it('grants nothing to a player who never took the offer', async () => {
    await createOffer({ minDeposit: '20' });
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `offers-none-${randomUUID()}@example.test`,
    });

    await deposit(client, '500');
    await settled(userId);

    expect(await grantsOf(userId)).toHaveLength(0);
  });

  it('refuses an offer that is not live', async () => {
    const offer = await createOffer({ status: 'draft' });
    const { client } = await registerAndMaterializePlayer(app, {
      email: `offers-draft-${randomUUID()}@example.test`,
    });

    const res = await client.post(`/promo/offers/${offer.id}/opt-in`, {});

    expect(res.status).toBe(409);
  });
});
