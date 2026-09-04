import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  verifyEmailByOtp,
  verificationOtpFor,
  registrationRequestHeaders,
  asPlayer,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * The browser-reported IANA zone, driven through the REAL login route: the platform stores
 * it so a consumer can render a stored UTC timestamp on the player's own clock.
 *
 * Display metadata, and the tests hold it to that bar - an unrecognised zone costs the
 * player nothing, and a player who never sent one reads null rather than a guess derived
 * from `country` or `registrationIp`.
 */

let db: TestDb;
let app: TestApp;

const PASSWORD = 'password1234';

type PlayerRead = { timezone: string | null; timezoneUpdatedAt: string | null };

async function login(email: string, timezone?: string): Promise<Response> {
  return app.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, ...(timezone ? { timezone } : {}) }),
  });
}

/** The zone as the shared player read model exposes it - the same surface the backoffice reads. */
async function readProfile(client: TestClient): Promise<PlayerRead> {
  const res = await client.get('/profile');
  expect(res.status).toBe(200);
  return (await res.json()) as PlayerRead;
}

async function newPlayer(): Promise<{ client: TestClient; email: string }> {
  const email = `player-timezone-${randomUUID()}@e2e.test`;
  const { client } = await registerAndMaterializePlayer(app, { email, password: PASSWORD });
  return { client, email };
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('POST /identity/login - player timezone capture', () => {
  it('stores the zone a login carries and exposes it on the player read model', async () => {
    const { client, email } = await newPlayer();
    expect(await readProfile(client)).toMatchObject({ timezone: null, timezoneUpdatedAt: null });

    const res = await login(email, 'Europe/Warsaw');

    expect(res.status).toBe(200);
    const profile = await readProfile(client);
    expect(profile.timezone).toBe('Europe/Warsaw');
    expect(profile.timezoneUpdatedAt).not.toBeNull();
  });

  it('refreshes timezoneUpdatedAt when a later login reports the same zone', async () => {
    const { client, email } = await newPlayer();
    await login(email, 'Europe/Warsaw');
    const first = await readProfile(client);

    await login(email, 'Europe/Warsaw');

    const second = await readProfile(client);
    expect(second.timezone).toBe('Europe/Warsaw');
    expect(new Date(second.timezoneUpdatedAt!).getTime()).toBeGreaterThan(
      new Date(first.timezoneUpdatedAt!).getTime(),
    );
  });

  it('updates both columns when a login reports a different zone', async () => {
    const { client, email } = await newPlayer();
    await login(email, 'Europe/Warsaw');
    const before = await readProfile(client);

    await login(email, 'America/New_York');

    const after = await readProfile(client);
    expect(after.timezone).toBe('America/New_York');
    expect(new Date(after.timezoneUpdatedAt!).getTime()).toBeGreaterThan(
      new Date(before.timezoneUpdatedAt!).getTime(),
    );
  });

  it('ignores a zone the runtime does not recognise and still signs the player in', async () => {
    const { client, email } = await newPlayer();

    const res = await login(email, 'Mars/Phobos');

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeTruthy();
    expect(await readProfile(client)).toMatchObject({ timezone: null, timezoneUpdatedAt: null });
  });

  it('signs the player in when the client sends an empty zone rather than omitting it', async () => {
    const { client, email } = await newPlayer();

    const res = await app.app.request('/identity/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD, timezone: '' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toBeTruthy();
    expect(await readProfile(client)).toMatchObject({ timezone: null, timezoneUpdatedAt: null });
  });

  it('reads null for a player whose sessions never carried a zone', async () => {
    const { client, email } = await newPlayer();

    await login(email);

    expect(await readProfile(client)).toMatchObject({ timezone: null, timezoneUpdatedAt: null });
  });
});

describe('PATCH /profile - player timezone capture', () => {
  it('captures the zone from the once-per-session profile write', async () => {
    const { client } = await newPlayer();

    const res = await client.patch('/profile', { timezone: 'Asia/Tokyo' });

    expect(res.status).toBe(200);
    expect((await res.json()) as PlayerRead).toMatchObject({ timezone: 'Asia/Tokyo' });
    expect(await readProfile(client)).toMatchObject({ timezone: 'Asia/Tokyo' });
  });

  it('ignores an unrecognised zone without failing the profile update', async () => {
    const { client } = await newPlayer();

    const res = await client.patch('/profile', { timezone: 'Mars/Phobos', country: 'GB' });

    expect(res.status).toBe(200);
    expect((await res.json()) as PlayerRead & { country: string }).toMatchObject({
      country: 'GB',
      timezone: null,
    });
  });
});

describe('POST /identity/email/verify - player timezone capture', () => {
  it('captures the zone on the route that mints the first session', async () => {
    const email = `player-timezone-verify-${randomUUID()}@e2e.test`;
    const username = `tzver_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    const registered = await app.app.request('/identity/register', {
      method: 'POST',
      headers: registrationRequestHeaders(),
      body: JSON.stringify({
        email,
        password: PASSWORD,
        username,
        acceptedTerms: true,
        acceptedAge: true,
      }),
    });
    expect(registered.status).toBe(200);

    const verified = await app.app.request('/identity/email/verify', {
      method: 'POST',
      headers: registrationRequestHeaders(),
      body: JSON.stringify({
        email,
        otp: await verificationOtpFor(email),
        timezone: 'Asia/Tokyo',
      }),
    });
    expect(verified.status).toBe(200);

    const client = await asPlayer(app.app, { email, password: PASSWORD });
    expect(await readProfile(client)).toMatchObject({ timezone: 'Asia/Tokyo' });
  });
});

describe('POST /identity/register - player timezone capture', () => {
  it('stores the zone the sign-up form carried, before any session exists', async () => {
    const email = `player-timezone-register-${randomUUID()}@e2e.test`;
    const username = `tzreg_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

    const res = await app.app.request('/identity/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': '198.19.0.7' },
      body: JSON.stringify({
        email,
        password: PASSWORD,
        username,
        acceptedTerms: true,
        acceptedAge: true,
        timezone: 'Australia/Sydney',
      }),
    });
    expect(res.status).toBe(200);

    await verifyEmailByOtp(app, email);
    const client = await asPlayer(app.app, { email, password: PASSWORD });

    expect(await readProfile(client)).toMatchObject({ timezone: 'Australia/Sydney' });
  });
});
