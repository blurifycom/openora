import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  setupTestDb,
  bootTestApp,
  registerPlayer,
  submitRegistration,
  markEmailVerified,
  seedMinimal,
  type TestDb,
  type TestApp,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const login = (email: string, password = 'password123') =>
  app.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

const userIdFor = async (email: string) => {
  const [row] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, email.toLowerCase()));
  return row?.id;
};

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

describe('registration email verification gate', () => {
  it('refuses login until the address is verified, then allows it', async () => {
    const email = `reg-verify-${randomUUID()}@e2e.test`;
    const res = await submitRegistration(app, { email });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'check-email' });
    expect(res.headers.get('set-cookie')).toBeNull();

    const beforeVerify = await login(email);
    expect(beforeVerify.ok).toBe(false);

    const userId = await userIdFor(email);
    expect(userId).toBeDefined();
    await markEmailVerified(app, userId!);

    const afterVerify = await login(email);
    expect(afterVerify.ok).toBe(true);
    expect(afterVerify.headers.get('set-cookie')).toBeTruthy();
  });

  it('records the terms and age acceptance on the player row at registration', async () => {
    const email = `reg-consent-${randomUUID()}@e2e.test`;
    const userId = await registerPlayer(app, { email });

    const [row] = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(player)
      .where(eq(player.userId, userId));

    expect(row).toBeDefined();
    expect(row?.termsVersion).toBe('test-v1');
    expect(row?.termsAcceptedAt).toBeInstanceOf(Date);
    expect(row?.ageAcceptedAt).toBeInstanceOf(Date);
    expect(row?.registrationIp).not.toBeNull();
  });

  it('rejects a username that is already taken, case-insensitively', async () => {
    const username = `dup_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    await registerPlayer(app, { email: `reg-dup-a-${randomUUID()}@e2e.test`, username });

    const res = await submitRegistration(app, {
      email: `reg-dup-b-${randomUUID()}@e2e.test`,
      username: username.toUpperCase(),
    });
    expect(res.status).toBe(409);
  });

  it('reports username availability against the case-insensitive index', async () => {
    const username = `avail_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
    const free = await app.app.request(`/identity/username-available?username=${username}`);
    expect(await free.json()).toEqual({ available: true });

    await registerPlayer(app, { email: `reg-avail-${randomUUID()}@e2e.test`, username });

    const taken = await app.app.request(
      `/identity/username-available?username=${username.toUpperCase()}`,
    );
    expect(await taken.json()).toEqual({ available: false });
  });
});
