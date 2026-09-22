import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { countryRule } from '@openora/core/compliance/schema';
import { bootTestApp, seedMinimal, setupTestDb, type TestApp, type TestDb } from '../index.js';

const BLOCKED_IP = '203.0.113.10';
const BLOCKED_COUNTRY = 'DE';
const ALLOWED_IP = '203.0.113.20';
const UNRESOLVABLE_IP = '198.51.100.7';

let db: TestDb;
let app: TestApp;

function geoCheck(ip: string) {
  return app.app.request('/compliance/geo-check', { headers: { 'x-real-ip': ip } });
}

function login(ip: string, email: string) {
  return app.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ email, password: 'password1234' }),
  });
}

function register(ip: string, email: string) {
  return app.app.request('/identity/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({
      email,
      password: 'password1234',
      username: `p${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      acceptedTerms: true,
      acceptedAge: true,
    }),
  });
}

function blockedAuditRows(countryCode: string) {
  return app.container
    .get(DRIZZLE)
    .db.select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, 'compliance.geo.access_blocked'),
        eq(auditLog.resourceId, countryCode),
      ),
    );
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-geo-ip',
        path: fileURLToPath(new URL('../test-geo-ip-plugin.ts', import.meta.url)),
      },
    ],
    databaseUrl: db.url,
  });
  await seedMinimal(app.container, { playerCount: 0 });
  await app.container
    .get(DRIZZLE)
    .db.insert(countryRule)
    .values({ countryCode: BLOCKED_COUNTRY, action: 'block' })
    .onConflictDoUpdate({ target: countryRule.countryCode, set: { action: 'block' } });
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('country access enforcement', () => {
  it('answers the anonymous geo-check with the caller’s decision', async () => {
    const allowed = await geoCheck(ALLOWED_IP);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ allowed: true, countryCode: 'PL' });

    const blocked = await geoCheck(BLOCKED_IP);
    expect(blocked.status).toBe(200);
    expect(await blocked.json()).toMatchObject({
      allowed: false,
      countryCode: BLOCKED_COUNTRY,
      reason: `Country ${BLOCKED_COUNTRY} is blocked`,
    });
  });

  it('fails closed on an address that resolves to no country while a block rule exists', async () => {
    const res = await geoCheck(UNRESOLVABLE_IP);

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ allowed: false, countryCode: null });
  });

  it('refuses registration and login from a blacklisted country', async () => {
    const email = `blocked-${randomUUID()}@e2e.test`;

    expect((await register(BLOCKED_IP, email)).status).toBe(403);
    expect((await login(BLOCKED_IP, email)).status).toBe(403);
  });

  it('logs every refused attempt with the resolved country and a timestamp', async () => {
    const before = (await blockedAuditRows(BLOCKED_COUNTRY)).length;
    await geoCheck(BLOCKED_IP);

    await vi.waitFor(async () => {
      expect((await blockedAuditRows(BLOCKED_COUNTRY)).length).toBeGreaterThan(before);
    });
    const latest = (await blockedAuditRows(BLOCKED_COUNTRY)).at(-1);
    expect(latest).toMatchObject({
      actorType: 'system',
      resourceType: 'geo-access',
      resourceId: BLOCKED_COUNTRY,
      result: 'failure',
      after: { countryCode: BLOCKED_COUNTRY, reason: `Country ${BLOCKED_COUNTRY} is blocked` },
    });
    expect(latest?.createdAt).toBeInstanceOf(Date);
  });

  it('throttles the anonymous geo-check per address', async () => {
    const hotIp = '203.0.113.99';
    let lastStatus = 200;

    for (let attempt = 0; attempt < 70 && lastStatus === 200; attempt += 1) {
      lastStatus = (await geoCheck(hotIp)).status;
    }

    expect(lastStatus).toBe(429);
    expect((await geoCheck(ALLOWED_IP)).status).toBe(200);
  });
});
