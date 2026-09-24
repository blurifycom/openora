import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * Self-service `PATCH /profile` lets `phone` and `country` be set independently. This
 * cross-validates the effective pair (this request's value, else whatever is already
 * stored) by calling code - not by exact-country match, since territories such as
 * GB/GG/JE/IM share +44 - and rejects before any write when they disagree.
 */

let db: TestDb;
let app: TestApp;

type PlayerRead = { phone: string | null; country: string | null };

async function newPlayer(): Promise<{ client: TestClient }> {
  const email = `profile-phone-country-${randomUUID()}@e2e.test`;
  const { client } = await registerAndMaterializePlayer(app, { email });
  return { client };
}

async function readProfile(client: TestClient): Promise<PlayerRead> {
  const res = await client.get('/profile');
  expect(res.status).toBe(200);
  return (await res.json()) as PlayerRead;
}

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
  await app?.close();
  await db?.dispose();
});

describe('PATCH /profile - phone/country calling-code validation', () => {
  it('accepts a phone whose calling code matches the country in the same PATCH', async () => {
    const { client } = await newPlayer();

    const res = await client.patch('/profile', { phone: '+441632960001', country: 'GB' });

    expect(res.status).toBe(200);
    expect(await readProfile(client)).toMatchObject({ phone: '+441632960001', country: 'GB' });
  });

  it('accepts a same-calling-code territory instead of requiring an exact country match', async () => {
    const { client } = await newPlayer();

    const res = await client.patch('/profile', { phone: '+12025550123', country: 'CA' });

    expect(res.status).toBe(200);
    expect(await readProfile(client)).toMatchObject({ phone: '+12025550123', country: 'CA' });
  });

  it('rejects a mismatched phone/country pair sent in one PATCH and writes nothing', async () => {
    const { client } = await newPlayer();

    const res = await client.patch('/profile', { phone: '+14155552671', country: 'GB' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      data: { reason: 'phone_country_mismatch' },
    });
    expect(await readProfile(client)).toMatchObject({ phone: null, country: null });
  });

  it('rejects contract-valid values that have no calling-code metadata', async () => {
    const { client } = await newPlayer();

    const res = await client.patch('/profile', { phone: '+99912345678', country: 'ZZ' });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      code: 'BAD_REQUEST',
      data: { reason: 'phone_country_mismatch' },
    });
    expect(await readProfile(client)).toMatchObject({ phone: null, country: null });
  });

  it('rejects a phone-only PATCH when it disagrees with the already-stored country', async () => {
    const { client } = await newPlayer();
    const setup = await client.patch('/profile', { country: 'GB' });
    expect(setup.status).toBe(200);

    const res = await client.patch('/profile', { phone: '+14155552671' });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await readProfile(client)).toMatchObject({ phone: null, country: 'GB' });
  });

  it('accepts a phone-only PATCH when no country was ever stored', async () => {
    const { client } = await newPlayer();
    expect(await readProfile(client)).toMatchObject({ phone: null, country: null });

    const res = await client.patch('/profile', { phone: '+14155552671' });

    expect(res.status).toBe(200);
    expect(await readProfile(client)).toMatchObject({ phone: '+14155552671', country: null });
  });
});
