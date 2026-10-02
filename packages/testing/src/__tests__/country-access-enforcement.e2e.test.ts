import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { auditLog } from '@openora/core/audit/schema';
import { countryRule } from '@openora/core/compliance/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  asAdmin,
  bootTestApp,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestDb,
} from '../index.js';
import { forceEmailVerified } from '../register.js';

const BLOCKED_IP = '203.0.113.10';
const BLOCKED_COUNTRY = 'DE';
const ALLOWED_IP = '203.0.113.20';
const REDIRECTED_IP = '203.0.113.30';
const REDIRECTED_COUNTRY = 'TR';
const MIRROR_URL = 'https://mirror.e2e.test';
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

function geoAuditRows(action: string, countryCode: string) {
  return app.container
    .get(DRIZZLE)
    .db.select()
    .from(auditLog)
    .where(and(eq(auditLog.action, action), eq(auditLog.resourceId, countryCode)));
}

const blockedAuditRows = (countryCode: string) =>
  geoAuditRows('compliance.geo.access_blocked', countryCode);

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
      {
        id: 'testing-mirror-target-policy',
        path: fileURLToPath(new URL('../test-mirror-target-policy-plugin.ts', import.meta.url)),
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
  const redirected = { action: 'block', redirectIp: true, mirrorUrl: MIRROR_URL } as const;
  await app.container
    .get(DRIZZLE)
    .db.insert(countryRule)
    .values({ countryCode: REDIRECTED_COUNTRY, ...redirected })
    .onConflictDoUpdate({ target: countryRule.countryCode, set: redirected });
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

  it('hands a blacklisted but redirected country its mirror and lets it register', async () => {
    const res = await geoCheck(REDIRECTED_IP);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      allowed: true,
      countryCode: REDIRECTED_COUNTRY,
      reason: null,
      redirectUrl: MIRROR_URL,
    });
    const before = (await geoAuditRows('compliance.geo.access_redirected', REDIRECTED_COUNTRY))
      .length;
    expect((await register(REDIRECTED_IP, `mirror-${randomUUID()}@e2e.test`)).status).toBe(200);
    await vi.waitFor(async () => {
      const rows = await geoAuditRows('compliance.geo.access_redirected', REDIRECTED_COUNTRY);
      expect(rows.length).toBeGreaterThan(before);
      expect(rows.at(-1)?.after).toEqual({
        countryCode: REDIRECTED_COUNTRY,
        redirectUrl: MIRROR_URL,
      });
    });
  });

  it('refuses registration from a blacklisted country', async () => {
    expect((await register(BLOCKED_IP, `blocked-${randomUUID()}@e2e.test`)).status).toBe(403);
  });

  it('refuses a proven login from a blacklisted country, but not from an allowed one', async () => {
    const email = `traveller-${randomUUID()}@e2e.test`;
    expect((await register(ALLOWED_IP, email)).status).toBe(200);
    const [registered] = await app.container
      .get(DRIZZLE)
      .db.select({ id: user.id })
      .from(user)
      .where(eq(user.email, email));
    if (!registered) {
      throw new Error('registered user was not persisted');
    }
    await forceEmailVerified(app, registered.id);

    const blocked = await login(BLOCKED_IP, email);
    expect(blocked.status).toBe(403);
    expect(blocked.headers.get('set-cookie')).toBeNull();
    expect((await login(ALLOWED_IP, email)).status).toBe(200);
  });

  it('logs every refused attempt with the resolved country and a timestamp', async () => {
    const before = (await blockedAuditRows(BLOCKED_COUNTRY)).length;
    // An enforcement point, which is audited on every refusal; the anonymous geo-check is
    // deduplicated per address and country, so it may already have been recorded.
    await register(BLOCKED_IP, `blocked-${randomUUID()}@e2e.test`);

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

describe('PUT /compliance/country-rules with a mirror', () => {
  const ruleFor = (overrides: Record<string, unknown>) => ({
    countryCode: 'FR',
    blacklisted: true,
    redirectIp: true,
    mirrorUrl: MIRROR_URL,
    kycRequired: true,
    expectedUpdatedAt: null,
    confirm: true,
    ...overrides,
  });

  const reasonOf = async (res: Response) =>
    ((await res.json()) as { data?: { reason?: string } }).data?.reason;

  it('refuses a mirror that is not a bare https origin', async () => {
    const admin = await asAdmin(app.app);

    const res = await admin.put(
      '/compliance/country-rules',
      ruleFor({ mirrorUrl: `${MIRROR_URL}/play` }),
    );

    expect(res.status).toBe(400);
  });

  it('asks for confirmation before a mirror opens a blacklisted country', async () => {
    const admin = await asAdmin(app.app);

    const res = await admin.put('/compliance/country-rules', ruleFor({ confirm: undefined }));

    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('confirmation_required');
  });

  it('refuses a mirror origin the operator has not approved', async () => {
    const admin = await asAdmin(app.app);

    const res = await admin.put(
      '/compliance/country-rules',
      ruleFor({ mirrorUrl: 'https://unapproved.e2e.test' }),
    );

    expect(res.status).toBe(409);
    expect(await reasonOf(res)).toBe('mirror_not_approved');
    const rows = await app.container
      .get(DRIZZLE)
      .db.select()
      .from(countryRule)
      .where(eq(countryRule.countryCode, 'FR'));
    expect(rows.at(0)?.mirrorUrl ?? null).toBeNull();
  });

  it('redirects a blacklisted country to an approved mirror and reports it as redirected', async () => {
    const admin = await asAdmin(app.app);

    const res = await admin.put('/compliance/country-rules', ruleFor({}));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      countryCode: 'FR',
      blacklisted: true,
      mirrorUrl: MIRROR_URL,
      effectiveAccess: 'redirected',
    });
    const listed = (await (await admin.get('/compliance/country-rules')).json()) as Array<{
      countryCode: string;
      effectiveAccess: string;
    }>;
    expect(listed.find((rule) => rule.countryCode === 'FR')?.effectiveAccess).toBe('redirected');
    expect(listed.find((rule) => rule.countryCode === BLOCKED_COUNTRY)?.effectiveAccess).toBe(
      'blocked',
    );
  });
});
