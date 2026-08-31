import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { player } from '@openora/core/pam/schema/profile';
import { kycVerification } from '@openora/core/compliance/schema';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
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

async function seedLegacyVerifiedStatus(container: Container<CoreTokenCatalog>, userId: string) {
  await container
    .get(DRIZZLE)
    .db.update(player)
    .set({ kycStatus: 'verified' })
    .where(eq(player.userId, userId));
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
    const { client, userId, playerId } = await registerAndMaterializePlayer(appDefault, {
      email: email,
    });

    const submitRes = await client.post('/compliance/kyc', {
      tier: 'basic',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(submitRes.status).toBe(200);
    const submitted = await readJson(submitRes);
    expect(submitted.userId).toBe(userId);
    expect(submitted.status).toBe('approved');

    const admin = await asAdmin(appDefault.app);

    const kycRes = await admin.get(`/compliance/players/${userId}/kyc`);
    expect(kycRes.status).toBe(200);
    const kycView = await readJson(kycRes);
    expect(kycView.basic.current.status).toBe('approved');
    expect(kycView.basic.history).toHaveLength(1);
    expect(kycView.advanced).toEqual({ current: null, history: [] });

    // Authz negative: the player themself is not an admin.
    const asSelfRes = await client.get(`/compliance/players/${userId}/kyc`);
    expect(asSelfRes.status).toBe(403);

    // Authz negative: no session at all.
    const anonRes = await appDefault.app.request(`/compliance/players/${userId}/kyc`);
    expect(anonRes.status).toBe(401);

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=compliance.kyc.submitted`,
      );
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].actorType).toBe('player');
      expect(body.items[0].actorId).toBe(playerId);
    });

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=compliance.kyc.updated`,
      );
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].before).toMatchObject({ kycStatus: 'pending' });
      expect(body.items[0].after).toMatchObject({
        kycStatus: 'approved',
        source: 'vendor',
      });
    });
  });
});

describe('KYC webhook reconcile (gated stack)', () => {
  it('a valid HMAC signature reconciles; a forged/missing one is rejected and changes nothing', async () => {
    const email = `kyc-webhook-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appGated, {
      email: email,
    });
    const admin = await asAdmin(appGated.app);

    const submitRes = await client.post('/compliance/kyc', {
      tier: 'basic',
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
    expect(unchanged.basic.current.status).toBe('pending');

    const validSig = signWebhook(payload, KYC_WEBHOOK_SECRET);
    const validRes = await appGated.app.request('/compliance/kyc/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-kyc-signature': validSig },
      body: payload,
    });
    expect(validRes.status).toBe(200);
    expect(await readJson(validRes)).toEqual({ ok: true });

    await vi.waitFor(async () => {
      const reconciled = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
      expect(reconciled.basic.current.status).toBe('approved');
      expect(reconciled.basic.current.decidedAt).not.toBeNull();
    });

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=compliance.kyc.updated`,
      );
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].actorType).toBe('system');
      expect(body.items[0].before).toMatchObject({ kycStatus: 'pending' });
      expect(body.items[0].after).toMatchObject({
        kycStatus: 'approved',
        source: 'webhook',
      });
    });
  });
});

describe('KYC tiers (gated stack)', () => {
  it('tracks an Advanced webhook decision independently without changing the Basic withdrawal status', async () => {
    const email = `kyc-tiers-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email });
    const admin = await asAdmin(appGated.app);

    const initial = await client.get('/compliance/kyc/me');
    expect(initial.status).toBe(200);
    expect(await readJson(initial)).toEqual({
      basic: { current: null, history: [] },
      advanced: { current: null, history: [] },
    });

    const advancedSubmit = await client.post('/compliance/kyc', {
      tier: 'advanced',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(advancedSubmit.status).toBe(200);
    const advanced = await readJson(advancedSubmit);
    expect(advanced.status).toBe('pending');

    const basicSubmit = await client.post('/compliance/kyc', {
      tier: 'basic',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(basicSubmit.status).toBe(200);

    const payload = JSON.stringify({ referenceId: advanced.referenceId, status: 'approved' });
    const resolved = await appGated.app.request('/compliance/kyc/webhook', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-kyc-signature': signWebhook(payload, KYC_WEBHOOK_SECRET),
      },
      body: payload,
    });
    expect(resolved.status).toBe(200);

    await vi.waitFor(async () => {
      const mine = await readJson(await client.get('/compliance/kyc/me'));
      expect(mine.basic.current.status).toBe('pending');
      expect(mine.advanced.current.status).toBe('approved');
    });
    expect((await readJson(await admin.get(`/players/by-user/${userId}`))).kycStatus).toBe(
      'pending',
    );
  });

  it('getMyKyc returns only status/tier/documentTypes/timestamps, never risk-signal internals', async () => {
    const email = `kyc-summary-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email });
    const admin = await asAdmin(appGated.app);

    const submitRes = await client.post('/compliance/kyc', {
      tier: 'basic',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    const submitted = await readJson(submitRes);

    // Populate the fraud-detection fields directly - the test adapter's webhook has no
    // way to supply them, but a real hosted-session vendor's decision would.
    await appGated.container
      .get(DRIZZLE)
      .db.update(kycVerification)
      .set({
        riskSignals: {
          vpnOrTorDetected: true,
          dataCenterIpDetected: false,
          duplicateDeviceDetected: false,
          highRiskCountryDetected: false,
          deviceFingerprints: ['fp-1'],
        },
        checks: [{ step: 'ID_VERIFICATION', status: 'approved' }],
        decisionReason: 'internal fraud note',
      })
      .where(eq(kycVerification.userId, userId));

    const mine = await readJson(await client.get('/compliance/kyc/me'));
    const mineCurrent = mine.basic.current;
    expect(mineCurrent).toEqual({
      tier: 'basic',
      status: submitted.status,
      documentTypes: ['passport'],
      submittedAt: expect.any(String),
      decidedAt: mineCurrent.decidedAt,
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    expect(mineCurrent.riskSignals).toBeUndefined();
    expect(mineCurrent.checks).toBeUndefined();
    expect(mineCurrent.decisionReason).toBeUndefined();
    expect(mineCurrent.provider).toBeUndefined();
    expect(mineCurrent.referenceId).toBeUndefined();

    const adminView = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(adminView.basic.current.riskSignals.vpnOrTorDetected).toBe(true);
    expect(adminView.basic.current.decisionReason).toBe('internal fraud note');
  });

  it('getMyKyc scopes to the session user, never another players verification', async () => {
    const submitterEmail = `kyc-scope-submitter-${randomUUID()}@e2e.test`;
    const { client: submitterClient } = await registerAndMaterializePlayer(appGated, {
      email: submitterEmail,
    });
    await submitterClient.post('/compliance/kyc', {
      tier: 'basic',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });

    const bystanderEmail = `kyc-scope-bystander-${randomUUID()}@e2e.test`;
    const { client: bystanderClient } = await registerAndMaterializePlayer(appGated, {
      email: bystanderEmail,
    });

    const bystanderView = await readJson(await bystanderClient.get('/compliance/kyc/me'));
    expect(bystanderView).toEqual({
      basic: { current: null, history: [] },
      advanced: { current: null, history: [] },
    });
  });
});

describe('KYC withdrawal gate (gated stack)', () => {
  it('blocks an unapproved withdrawal, then allows it once an admin marks the player approved', async () => {
    const email = `kyc-withdraw-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appGated, {
      email: email,
    });
    const admin = await asAdmin(appGated.app);

    const depositRes = await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '2',
      currency: 'USD',
    });
    expect(depositRes.status).toBe(200);

    const blockedRes = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '0.5',
      currency: 'USD',
    });
    expect(blockedRes.status).toBe(409);

    const overrideRes = await admin.post(`/compliance/players/${userId}/kyc/override`, {
      tier: 'basic',
      status: 'approved',
      reason: 'manual review confirmed identity',
    });
    expect(overrideRes.status).toBe(200);
    expect((await readJson(overrideRes)).status).toBe('manually_overridden');
    expect((await readJson(await admin.get(`/players/by-user/${userId}`))).kycStatus).toBe(
      'manually_overridden',
    );

    const allowedRes = await client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '0.5',
      currency: 'USD',
    });
    expect(allowedRes.status).toBe(200);
    const allowed = await readJson(allowedRes);
    expect(allowed.status).toBe('pending');
    expect(allowed.transactionId).toBeTruthy();

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=compliance.kyc.updated`,
      );
      const body = await readJson(res);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].actorType).toBe('admin');
      expect(body.items[0].before).toMatchObject({ kycStatus: 'pending' });
      expect(body.items[0].after).toMatchObject({
        kycStatus: 'manually_overridden',
        reason: 'manual review confirmed identity',
        source: 'manual',
      });
    });
  });
});

describe('KYC threshold re-KYC on deposit (gated stack)', () => {
  it('a deposit crossing the per-currency threshold flips a legacy-verified player to resubmission_requested', async () => {
    const email = `kyc-rekyc-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email: email });
    const admin = await asAdmin(appGated.app);

    const submitRes = await client.post('/compliance/kyc', {
      tier: 'basic',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(submitRes.status).toBe(200);

    await seedLegacyVerifiedStatus(appGated.container, userId);
    expect((await readJson(await admin.get(`/players/by-user/${userId}`))).kycStatus).toBe(
      'verified',
    );

    // Fixture config sets kyc.reverifyThresholds.USD = 10; this crosses it.
    const depositRes = await client.post('/wallet/deposit', {
      idempotencyKey: randomUUID(),
      amount: '15',
      currency: 'USD',
    });
    expect(depositRes.status).toBe(200);

    await vi.waitFor(
      async () => {
        const kycView = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
        expect(kycView.basic.current.status).toBe('resubmission_requested');
        expect(kycView.basic.current.triggeredBy).toBe('reverify_threshold');
      },
      { timeout: 3000, interval: 100 },
    );
  });
});

describe('KYC admin actions: resubmit / override / bulk-approve (default stack)', () => {
  it('requestKycResubmission writes a manual history row, audits it, and notifies the player through the job queue', async () => {
    const email = `kyc-resubmit-${randomUUID()}@e2e.test`;
    const { client, userId, playerId } = await registerAndMaterializePlayer(appDefault, {
      email: email,
    });
    const admin = await asAdmin(appDefault.app);

    const anonRes = await appDefault.app.request(`/compliance/players/${userId}/kyc/resubmit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tier: 'basic', reason: 'not authenticated' }),
    });
    expect(anonRes.status).toBe(401);

    const asSelfRes = await client.post(`/compliance/players/${userId}/kyc/resubmit`, {
      tier: 'basic',
      reason: 'not an admin',
    });
    expect(asSelfRes.status).toBe(403);

    const res = await admin.post(`/compliance/players/${userId}/kyc/resubmit`, {
      tier: 'basic',
      reason: 'document photo is blurry',
    });
    expect(res.status).toBe(200);
    const dto = await readJson(res);
    expect(dto.status).toBe('resubmission_requested');
    expect(dto.triggeredBy).toBe('manual');
    expect(dto.provider).toBe('manual');

    const kycView = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(kycView.basic.current.status).toBe('resubmission_requested');
    expect(kycView.basic.current.triggeredBy).toBe('manual');

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=compliance.kyc.updated`,
      );
      const body = await readJson(auditRes);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      expect(body.items[0].actorType).toBe('admin');
      expect(body.items[0].after).toMatchObject({
        kycStatus: 'resubmission_requested',
        reason: 'document photo is blurry',
        source: 'manual',
      });
    });

    await vi.waitFor(async () => {
      const notifyRes = await client.get('/notifications');
      const { items } = await readJson(notifyRes);
      const found = (items as Array<{ type: string; body: string }>).find(
        (n) => n.type === 'kyc.resubmission_requested',
      );
      expect(found).toBeTruthy();
      expect(found?.body).toContain('document photo is blurry');
    });

    const historyBefore = kycView.basic.history.length;
    const repeatRes = await admin.post(`/compliance/players/${userId}/kyc/resubmit`, {
      tier: 'basic',
      reason: 'document photo is blurry, again',
    });
    expect(repeatRes.status).toBe(200);
    const kycViewAfterRepeat = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(kycViewAfterRepeat.basic.history.length).toBe(historyBefore);
  });

  it('overrideKycStatus writes a rejected choice verbatim (no manually_overridden remap) with reason + actor in the audit log', async () => {
    const email = `kyc-override-reject-${randomUUID()}@e2e.test`;
    const { userId, playerId } = await registerAndMaterializePlayer(appDefault, { email: email });
    const admin = await asAdmin(appDefault.app);

    const emptyReasonRes = await admin.post(`/compliance/players/${userId}/kyc/override`, {
      tier: 'basic',
      status: 'rejected',
      reason: '   ',
    });
    expect(emptyReasonRes.status).toBe(400);

    const res = await admin.post(`/compliance/players/${userId}/kyc/override`, {
      tier: 'basic',
      status: 'rejected',
      reason: 'document mismatch',
    });
    expect(res.status).toBe(200);
    expect((await readJson(res)).status).toBe('rejected');

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=compliance.kyc.updated`,
      );
      const body = await readJson(auditRes);
      expect(body.items[0].after).toMatchObject({
        kycStatus: 'rejected',
        reason: 'document mismatch',
        source: 'manual',
      });
    });
  });

  it('bulkApproveKyc approves multiple players (one audit entry each) and isolates a not-found id without losing the rest of the batch', async () => {
    const emailA = `kyc-bulk-a-${randomUUID()}@e2e.test`;
    const emailB = `kyc-bulk-b-${randomUUID()}@e2e.test`;
    const { userId: userA, playerId: playerA } = await registerAndMaterializePlayer(appDefault, {
      email: emailA,
    });
    const { userId: userB, playerId: playerB } = await registerAndMaterializePlayer(appDefault, {
      email: emailB,
    });
    const missingUserId = randomUUID();
    const admin = await asAdmin(appDefault.app);

    const res = await admin.post('/compliance/kyc/bulk-approve', {
      userIds: [userA, userB, missingUserId],
      tier: 'basic',
      reason: 'bulk KYC sweep',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    const byUserId = new Map(
      (body.results as Array<{ userId: string; success: boolean; error: string | null }>).map(
        (r) => [r.userId, r],
      ),
    );
    expect(byUserId.get(userA)).toMatchObject({ success: true, error: null });
    expect(byUserId.get(userB)).toMatchObject({ success: true, error: null });
    expect(byUserId.get(missingUserId)?.success).toBe(false);
    expect(byUserId.get(missingUserId)?.error).toBeTruthy();

    for (const userId of [userA, userB]) {
      expect((await readJson(await admin.get(`/players/by-user/${userId}`))).kycStatus).toBe(
        'manually_overridden',
      );
    }

    await vi.waitFor(async () => {
      for (const playerId of [playerA, playerB]) {
        const auditRes = await admin.get(
          `/audit/logs?resourceId=${playerId}&action=compliance.kyc.updated`,
        );
        const auditBody = await readJson(auditRes);
        expect(auditBody.items.length).toBeGreaterThanOrEqual(1);
        expect(auditBody.items[0].after).toMatchObject({
          kycStatus: 'manually_overridden',
          reason: 'bulk KYC sweep',
          source: 'manual',
        });
      }
    });

    const rejectedRes = await admin.post('/compliance/kyc/bulk-approve', {
      userIds: [userA, userA],
      tier: 'basic',
      reason: 'duplicate ids should be rejected',
    });
    expect(rejectedRes.status).toBe(400);
  });
});

describe('Backoffice player list KYC status filter (legacy verified compatibility)', () => {
  it('filtering by the canonical "approved" also returns a player still holding the deprecated "verified" value', async () => {
    const email = `kyc-legacy-filter-${randomUUID()}@e2e.test`;
    const { userId } = await registerAndMaterializePlayer(appDefault, { email: email });
    const admin = await asAdmin(appDefault.app);

    // Simulates a player verified before the expand/contract migration - a real row a
    // pre-deploy instance could have written, never produced by current code.
    await seedLegacyVerifiedStatus(appDefault.container, userId);

    const approvedRes = await admin.get('/players?kycStatus=approved&limit=100');
    expect(approvedRes.status).toBe(200);
    const approvedBody = await readJson(approvedRes);
    const approvedIds = (approvedBody.items as Array<{ userId: string }>).map((p) => p.userId);
    expect(approvedIds).toContain(userId);

    const rejectedRes = await admin.get('/players?kycStatus=rejected&limit=100');
    const rejectedBody = await readJson(rejectedRes);
    const rejectedIds = (rejectedBody.items as Array<{ userId: string }>).map((p) => p.userId);
    expect(rejectedIds).not.toContain(userId);
  });
});

describe('KYC status writer concurrency (real Postgres FOR UPDATE)', () => {
  it('two concurrent overrideKycStatus calls to the same target status write exactly one history row and one audit entry', async () => {
    const email = `kyc-concurrent-override-${randomUUID()}@e2e.test`;
    const { userId, playerId } = await registerAndMaterializePlayer(appDefault, { email: email });
    const admin = await asAdmin(appDefault.app);

    // Two real HTTP requests racing through the full router -> service -> Postgres
    // stack, genuinely concurrent transactions - not a mocked DB scripted to return
    // zero rows on the second call. Exercises the FOR UPDATE row lock +
    // conditional-UPDATE semantics documented in docs/standards/compliance.md.
    const [resA, resB] = await Promise.all([
      admin.post(`/compliance/players/${userId}/kyc/override`, {
        tier: 'basic',
        status: 'approved',
        reason: 'concurrent review A',
      }),
      admin.post(`/compliance/players/${userId}/kyc/override`, {
        tier: 'basic',
        status: 'approved',
        reason: 'concurrent review B',
      }),
    ]);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);

    const kycView = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(kycView.basic.history).toHaveLength(1);
    expect(kycView.basic.current.status).toBe('manually_overridden');

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=compliance.kyc.updated`,
      );
      const auditBody = await readJson(auditRes);
      expect(auditBody.items).toHaveLength(1);
    });
  });
});
