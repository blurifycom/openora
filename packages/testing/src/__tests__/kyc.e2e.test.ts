import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadExtensions } from '@openora/core/server';
import {
  setupTestDb,
  bootTestApp,
  asPlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
} from '../index.js';

/**
 * End-to-end coverage for the KYC verification backend (submit, admin read, webhook
 * reconcile, withdrawal gate, threshold re-KYC, audit trail) driven over real HTTP
 * against the real Hono + oRPC app (bootTestApp) and a real Postgres test db. Pure
 * service-level logic (vendor-status mapping, the re-KYC watermark math, HMAC
 * verification) is already unit-tested next to the code (see compliance/__tests__ +
 * wallet/__tests__ in @openora/core) - this suite only exercises the wiring a unit
 * test with a mocked DB cannot: real routing, real authz, real DB state, and the
 * real (fire-and-forget) event -> audit pipeline.
 *
 * Two app instances share one database:
 * - `appDefault` boots the stock stack (MockKycAdapter, no PLATFORM_CONFIG bound - the
 *   withdrawal gate is therefore off) to prove the default submit/admin-read path.
 * - `appGated` adds a test-only overlay (fixtures/test-kyc-config-plugin.ts) binding
 *   PLATFORM_CONFIG (kyc.gateWithdrawals + reverifyThresholds) and a controllable
 *   KYC_ADAPTER (never auto-approves, implements parseWebhook) so the webhook,
 *   withdrawal-gate, and re-KYC paths can be driven deterministically. Both bindings
 *   must exist BEFORE the compliance/wallet routers are built (they resolve their
 *   config once at boot), so the overlay is passed in `plugins`, not poked into the
 *   container after bootTestApp resolves.
 */

const KYC_WEBHOOK_SECRET = 'e2e-kyc-webhook-secret';

let db: TestDb;
let appDefault: TestApp;
let appGated: TestApp;

function signWebhook(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function registerAndMaterializePlayer(app: TestApp['app'], email: string) {
  const registerRes = await app.request('/identity/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', name: 'KYC E2E Player' }),
  });
  if (!registerRes.ok) {
    throw new Error(`register failed (${registerRes.status}): ${await registerRes.text()}`);
  }
  const client = await asPlayer(app, { email });
  const profileRes = await client.get('/profile');
  if (!profileRes.ok) {
    throw new Error(
      `profile materialize failed (${profileRes.status}): ${await profileRes.text()}`,
    );
  }
  const profile = (await profileRes.json()) as { id: string; userId: string };
  return { client, playerId: profile.id, userId: profile.userId };
}

beforeAll(async () => {
  process.env['KYC_WEBHOOK_SECRET'] = KYC_WEBHOOK_SECRET;
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();

  appDefault = await bootTestApp({ plugins: basePlugins, databaseUrl: db.url });

  const fixturePath = fileURLToPath(
    new URL('./fixtures/test-kyc-config-plugin.ts', import.meta.url),
  );
  appGated = await bootTestApp({
    plugins: [...basePlugins, { id: 'test-kyc-config', path: fixturePath }],
    databaseUrl: db.url,
  });

  // Both apps share one database - seed the admin fixture once via appDefault's
  // container; appGated's asAdmin() logs into the same underlying `user` row.
  await seedMinimal(appDefault.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await appDefault?.close();
  await appGated?.close();
  await db?.dispose();
});

describe('KYC submit (default MockKycAdapter) + admin read + authz', () => {
  it('auto-verifies via the mock vendor, is admin-readable, and is denied to non-admins', async () => {
    const email = `kyc-submit-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appDefault.app, email);

    const submitRes = await client.post('/compliance/kyc', {
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(submitRes.status).toBe(200);
    const submitted = await readJson(submitRes);
    expect(submitted.userId).toBe(userId);
    // MockKycAdapter always returns vendor 'approved' -> app maps it to 'verified'.
    expect(submitted.status).toBe('verified');

    const admin = await asAdmin(appDefault.app);

    const kycRes = await admin.get(`/compliance/players/${userId}/kyc`);
    expect(kycRes.status).toBe(200);
    const kycView = await readJson(kycRes);
    expect(kycView.current.status).toBe('verified');
    expect(kycView.history).toHaveLength(1);

    // Authz negative: the player themself is not an admin.
    const asSelfRes = await client.get(`/compliance/players/${userId}/kyc`);
    expect(asSelfRes.status).toBe(403);

    // Authz negative: no session at all.
    const anonRes = await appDefault.app.request(`/compliance/players/${userId}/kyc`);
    expect(anonRes.status).toBe(401);

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${userId}&action=compliance.kyc.submitted`,
      );
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].actorType).toBe('player');
      expect(body.items[0].actorId).toBe(userId);
    });

    await vi.waitFor(async () => {
      const res = await admin.get(`/audit/logs?resourceId=${userId}&action=compliance.kyc.updated`);
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].before).toMatchObject({ kycStatus: 'pending' });
      expect(body.items[0].after).toMatchObject({ kycStatus: 'verified' });
    });
  });
});

describe('KYC webhook reconcile (gated stack)', () => {
  it('a valid HMAC signature reconciles; a forged/missing one is rejected and changes nothing', async () => {
    const email = `kyc-webhook-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);

    const submitRes = await client.post('/compliance/kyc', {
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(submitRes.status).toBe(200);
    const submitted = await readJson(submitRes);
    // The gated stack's test adapter never auto-approves.
    expect(submitted.status).toBe('pending');
    const referenceId = submitted.referenceId as string;

    const payload = JSON.stringify({ referenceId, status: 'approved' });

    const forgedRes = await appGated.app.request('/compliance/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kyc-signature': 'sha256=deadbeef' },
      body: payload,
    });
    expect(forgedRes.status).toBe(401);

    const missingSigRes = await appGated.app.request('/compliance/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(missingSigRes.status).toBe(401);

    const unchanged = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(unchanged.current.status).toBe('pending');

    const validSig = signWebhook(payload, KYC_WEBHOOK_SECRET);
    const validRes = await appGated.app.request('/compliance/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kyc-signature': validSig },
      body: payload,
    });
    expect(validRes.status).toBe(200);
    expect(await readJson(validRes)).toEqual({ ok: true });

    const reconciled = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(reconciled.current.status).toBe('verified');
    expect(reconciled.current.decidedAt).not.toBeNull();

    await vi.waitFor(async () => {
      const res = await admin.get(`/audit/logs?resourceId=${userId}&action=compliance.kyc.updated`);
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].actorType).toBe('system');
      expect(body.items[0].before).toMatchObject({ kycStatus: 'pending' });
      expect(body.items[0].after).toMatchObject({ kycStatus: 'verified' });
    });
  });
});

describe('KYC withdrawal gate (gated stack)', () => {
  it('blocks an unverified withdrawal, then allows it once an admin marks the player verified', async () => {
    const email = `kyc-withdraw-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);

    const depositRes = await client.post('/wallet/deposit', { amount: '2', currency: 'USD' });
    expect(depositRes.status).toBe(200);

    const blockedRes = await client.post('/wallet/withdraw', { amount: '0.5', currency: 'USD' });
    expect(blockedRes.status).toBe(409);

    const overrideRes = await admin.patch(`/players/${playerId}`, { kycStatus: 'verified' });
    expect(overrideRes.status).toBe(200);
    expect((await readJson(overrideRes)).kycStatus).toBe('verified');

    const allowedRes = await client.post('/wallet/withdraw', { amount: '0.5', currency: 'USD' });
    expect(allowedRes.status).toBe(200);
    const allowed = await readJson(allowedRes);
    expect(allowed.status).toBe('pending');
    expect(allowed.transactionId).toBeTruthy();

    await vi.waitFor(async () => {
      const res = await admin.get(`/audit/logs?resourceId=${userId}&action=compliance.kyc.updated`);
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].actorType).toBe('admin');
      expect(body.items[0].before).toMatchObject({ kycStatus: 'pending' });
      expect(body.items[0].after).toMatchObject({ kycStatus: 'verified' });
    });
  });
});

describe('KYC threshold re-KYC on deposit (gated stack)', () => {
  it('a deposit crossing the per-currency threshold flips a verified player to resubmission_requested', async () => {
    const email = `kyc-rekyc-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appGated.app, email);
    const admin = await asAdmin(appGated.app);

    // Establish a kyc_verification row (submit), then bring the player to verified.
    const submitRes = await client.post('/compliance/kyc', {
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(submitRes.status).toBe(200);

    const overrideRes = await admin.patch(`/players/${playerId}`, { kycStatus: 'verified' });
    expect(overrideRes.status).toBe(200);
    expect((await readJson(overrideRes)).kycStatus).toBe('verified');

    // Fixture config sets kyc.reverifyThresholds.USD = 10; this crosses it.
    const depositRes = await client.post('/wallet/deposit', { amount: '15', currency: 'USD' });
    expect(depositRes.status).toBe(200);

    await vi.waitFor(
      async () => {
        const kycView = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
        expect(kycView.current.status).toBe('resubmission_requested');
        expect(kycView.current.triggeredBy).toBe('reverify_threshold');
      },
      { timeout: 3000, interval: 100 },
    );
  });
});
