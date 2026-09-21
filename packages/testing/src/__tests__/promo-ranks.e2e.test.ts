import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { WAGER_TRACKING } from '@openora/core/contracts';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const LADDER_KEYS = [
  'bronze',
  'silver',
  'gold',
  'crystal',
  'master',
  'champion',
  'titan',
  'legend',
];

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

const tierIdOf = (body: { tiers: { id: string; key: string }[] }, key: string) =>
  body.tiers.find((tier) => tier.key === key)?.id;

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app.close();
  await db.dispose();
});

describe('a player reading their rank', () => {
  it('shows a new player the whole ladder at the bottom tier with nothing wagered', async () => {
    const { client } = await registerAndMaterializePlayer(app, {
      email: `ranks-${randomUUID()}@example.test`,
    });

    const res = await client.get('/promo/ranks');
    const body = await readJson(res);

    expect(res.status).toBe(200);
    expect(body.currency).toBe('USDT');
    expect(body.lifetimeWagered).toBe('0');
    expect(body.tiers.map((tier: { key: string }) => tier.key)).toEqual(LADDER_KEYS);
    expect(body.tierId).toBe(tierIdOf(body, 'bronze'));
  });

  it('reflects a recorded wager in the total and the tier', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `ranks-${randomUUID()}@example.test`,
    });

    await app.container.get(DRIZZLE).db.transaction((tx) =>
      app.container.get(WAGER_TRACKING).recordWager(tx, {
        userId,
        currency: 'USDT',
        amount: '12000',
        weightedAmount: '12000',
        context: { provider: 'aggregator', product: 'casino' },
      }),
    );
    const body = await readJson(await client.get('/promo/ranks'));

    expect(body.lifetimeWagered).toBe('12000.000000000000000000');
    expect(body.tierId).toBe(tierIdOf(body, 'silver'));
  });

  it('is refused outright when signed out', async () => {
    const res = await app.app.request('/promo/ranks');

    expect(res.status).toBe(401);
  });
});
