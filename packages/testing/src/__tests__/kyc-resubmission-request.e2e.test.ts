import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, asc, sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE, withAdvisoryXactLock } from '@openora/core/server';
import { MCP_KERNEL, type ActionExecutionContext } from '@openora/core/contracts';
import { kycVerification } from '@openora/core/compliance/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  registerAndMaterializePlayer,
  asAdmin,
  bootE2e,
  closeE2e,
  readJson,
  type E2e,
} from '../index.js';
import {
  ADVANCED_SUBJECT,
  PIPELINE_WAIT,
  resubmissionEmails,
  resubmissionNotifications,
  resubmissionRequestEvents,
  settle,
} from '../kyc-resubmission-helpers.js';

let defaultE2e: E2e | undefined;
let gatedE2e: E2e | undefined;
let appDefault: E2e['app'];
let appGated: E2e['app'];

async function seededAdminId(app: E2e['app']) {
  const [seededAdmin] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, 'admin@oss.dev'));
  if (!seededAdmin) {
    throw new Error('the seeded admin is missing');
  }
  return seededAdmin.id;
}

async function executeRequestEnhancedKyc(
  app: E2e['app'],
  input: { playerId: string; reason: string },
  proposalId: string = randomUUID(),
) {
  const execution: ActionExecutionContext = {
    proposalId,
    actor: { kind: 'admin', adminId: await seededAdminId(app) },
    correlationId: `kyc-${randomUUID()}`,
  };
  return app.container.get(MCP_KERNEL).executeAction('request_enhanced_kyc', input, execution);
}

beforeAll(async () => {
  const basePlugins = await loadExtensions();
  defaultE2e = await bootE2e({ plugins: basePlugins });
  appDefault = defaultE2e.app;

  const fixturePath = fileURLToPath(
    new URL('./fixtures/test-kyc-config-plugin.ts', import.meta.url),
  );
  gatedE2e = await bootE2e({
    plugins: [...basePlugins, { id: 'test-kyc-config', path: fixturePath }],
  });
  appGated = gatedE2e.app;
}, 60_000);

afterAll(async () => {
  await Promise.all([defaultE2e && closeE2e(defaultE2e), gatedE2e && closeE2e(gatedE2e)]);
});

describe('an approved request_enhanced_kyc agent action', () => {
  it('notifies the player once in-app and once by email as advanced, and a replay sends nothing more', async () => {
    const email = `kyc-agent-adv-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appDefault, { email });
    const bystanderEmail = `kyc-agent-bystander-${randomUUID()}@e2e.test`;
    const bystander = await registerAndMaterializePlayer(appDefault, { email: bystanderEmail });
    const reason = 'deposits crossed the enhanced due diligence threshold';
    const proposalId = randomUUID();

    expect(await executeRequestEnhancedKyc(appDefault, { playerId, reason }, proposalId)).toEqual({
      ok: true,
      outcome: 'applied',
    });

    await vi.waitFor(async () => {
      const found = await resubmissionNotifications(client);
      expect(found).toHaveLength(1);
      expect(found[0]?.params).toEqual({ reason, tier: 'advanced' });
      const mails = resubmissionEmails(email);
      expect(mails).toHaveLength(1);
      expect(mails[0]?.subject).toBe(ADVANCED_SUBJECT);
      expect(mails[0]?.text).toBe(
        `An admin has requested you complete enhanced verification. Reason: ${reason}.`,
      );
    }, PIPELINE_WAIT);

    expect(await executeRequestEnhancedKyc(appDefault, { playerId, reason }, proposalId)).toEqual({
      ok: true,
      outcome: 'already_applied',
    });
    await executeRequestEnhancedKyc(appDefault, { playerId, reason });
    await settle();
    // One committed request in the outbox: the replay and the repeat emitted nothing more.
    expect(
      await resubmissionRequestEvents(appDefault.container.get(DRIZZLE).db, userId),
    ).toHaveLength(1);
    expect(await resubmissionNotifications(client)).toHaveLength(1);
    expect(resubmissionEmails(email)).toHaveLength(1);
    expect(await resubmissionNotifications(bystander.client)).toHaveLength(0);
    expect(resubmissionEmails(bystanderEmail)).toHaveLength(0);
  });
});

describe('request_enhanced_kyc while an advanced verification is in progress', () => {
  it('is refused while advanced is pending, writing and sending nothing', async () => {
    const email = `kyc-agent-pending-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appGated, { email });
    const admin = await asAdmin(appGated.app);
    const submit = await client.post('/compliance/kyc', {
      tier: 'advanced',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(submit.status).toBe(200);

    const result = await executeRequestEnhancedKyc(appGated, {
      playerId,
      reason: 'enhanced checks',
    });
    expect(result).toEqual({ ok: false, error: 'verification_in_progress' });
    const view = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(view.advanced.history).toHaveLength(1);
    expect(view.advanced.current.status).toBe('pending');
    expect(
      await resubmissionRequestEvents(appGated.container.get(DRIZZLE).db, userId),
    ).toHaveLength(0);
    expect(await resubmissionNotifications(client)).toHaveLength(0);
    expect(resubmissionEmails(email)).toHaveLength(0);
  });

  it('is refused while advanced is not_started, writing and sending nothing', async () => {
    const email = `kyc-agent-not-started-${randomUUID()}@e2e.test`;
    const { client, playerId, userId } = await registerAndMaterializePlayer(appDefault, { email });
    const admin = await asAdmin(appDefault.app);
    await appDefault.container
      .get(DRIZZLE)
      .db.insert(kycVerification)
      .values({
        userId,
        provider: 'e2e-vendor',
        referenceId: `e2e-${randomUUID()}`,
        tier: 'advanced',
        status: 'not_started',
        documentTypes: [],
        triggeredBy: 'submission',
      });

    const result = await executeRequestEnhancedKyc(appDefault, {
      playerId,
      reason: 'enhanced checks',
    });
    expect(result).toEqual({ ok: false, error: 'verification_in_progress' });
    const view = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(view.advanced.history).toHaveLength(1);
    expect(view.advanced.current.status).toBe('not_started');
    expect(
      await resubmissionRequestEvents(appDefault.container.get(DRIZZLE).db, userId),
    ).toHaveLength(0);
    expect(await resubmissionNotifications(client)).toHaveLength(0);
    expect(resubmissionEmails(email)).toHaveLength(0);
  });
});

describe('override to resubmission_requested', () => {
  it('notifies once as advanced, and overriding again to the same status sends nothing', async () => {
    const email = `kyc-override-resub-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appDefault, { email });
    const admin = await asAdmin(appDefault.app);
    const url = `/compliance/players/${userId}/kyc/override`;

    const first = await admin.post(url, {
      tier: 'advanced',
      status: 'resubmission_requested',
      reason: 'enhanced due diligence',
    });
    expect(first.status).toBe(200);
    expect(await readJson(first)).toMatchObject({
      tier: 'advanced',
      status: 'resubmission_requested',
    });

    await vi.waitFor(async () => {
      const found = await resubmissionNotifications(client);
      expect(found).toHaveLength(1);
      expect(found[0]?.params).toEqual({ reason: 'enhanced due diligence', tier: 'advanced' });
      expect(resubmissionEmails(email)).toHaveLength(1);
      expect(resubmissionEmails(email)[0]?.subject).toBe(ADVANCED_SUBJECT);
    }, PIPELINE_WAIT);

    const view = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    const again = await admin.post(url, {
      tier: 'advanced',
      status: 'resubmission_requested',
      reason: 'enhanced due diligence, second click',
    });
    expect(again.status).toBe(200);
    const viewAfter = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(viewAfter.advanced.history.length).toBe(view.advanced.history.length);
    await settle();
    expect(await resubmissionNotifications(client)).toHaveLength(1);
    expect(resubmissionEmails(email)).toHaveLength(1);
  });
});

describe('request input attacks', () => {
  it('rejects a tier outside the enum and writes nothing', async () => {
    const { client, userId } = await registerAndMaterializePlayer(appDefault, {
      email: `kyc-resubmit-tier-${randomUUID()}@e2e.test`,
    });
    const admin = await asAdmin(appDefault.app);
    const url = `/compliance/players/${userId}/kyc/resubmit`;

    for (const tier of ['premium', 'ADVANCED', '', null, 2]) {
      expect((await admin.post(url, { tier, reason: 'valid reason' })).status).toBe(400);
    }
    const view = await readJson(await admin.get(`/compliance/players/${userId}/kyc`));
    expect(view.basic.history).toHaveLength(0);
    expect(view.advanced.history).toHaveLength(0);
    expect(
      await resubmissionRequestEvents(appDefault.container.get(DRIZZLE).db, userId),
    ).toHaveLength(0);
    expect(await resubmissionNotifications(client)).toHaveLength(0);
  });

  it('a player cannot request a resubmission for another player', async () => {
    const attacker = await registerAndMaterializePlayer(appDefault, {
      email: `kyc-resubmit-attacker-${randomUUID()}@e2e.test`,
    });
    const victim = await registerAndMaterializePlayer(appDefault, {
      email: `kyc-resubmit-victim-${randomUUID()}@e2e.test`,
    });
    const res = await attacker.client.post(`/compliance/players/${victim.userId}/kyc/resubmit`, {
      tier: 'advanced',
      reason: 'forged request',
    });
    expect(res.status).toBe(403);
    expect(
      await resubmissionRequestEvents(appDefault.container.get(DRIZZLE).db, victim.userId),
    ).toHaveLength(0);
    expect(await resubmissionNotifications(victim.client)).toHaveLength(0);
  });
});

describe('staff request racing the player advanced submit (real Postgres advisory lock)', () => {
  const db = () => appGated.container.get(DRIZZLE).db;

  function advancedStatuses(userId: string) {
    return db()
      .select({ status: kycVerification.status })
      .from(kycVerification)
      .where(and(eq(kycVerification.userId, userId), eq(kycVerification.tier, 'advanced')))
      .orderBy(asc(kycVerification.createdAt))
      .then((rows) => rows.map((r) => r.status));
  }

  async function holdAdvancedSubmitLock(userId: string, underLock: () => Promise<void>) {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = () => {};
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const hold = db().transaction((trx) =>
      withAdvisoryXactLock(trx, `kyc-submit:${userId}:advanced`, async () => {
        await underLock();
        held();
        await released;
      }),
    );
    await Promise.race([holding, hold]);
    return {
      release: async () => {
        release();
        await hold;
      },
    };
  }

  async function waitForRequestParkedOnSubmitLock(userId: string) {
    const key = `kyc-submit:${userId}:advanced`;
    await vi.waitFor(
      async () => {
        const { rows } = await db().execute<{ waiting: number }>(
          sql`select count(*)::int as waiting from pg_locks
              where locktype = 'advisory' and not granted
                and objid::bigint = (hashtext(${key})::bigint & 4294967295)`,
        );
        expect(rows[0]?.waiting ?? 0).toBeGreaterThan(0);
      },
      { timeout: 5_000, interval: 20 },
    );
  }

  it('a request arriving while a submit holds the lock waits for it, then is refused and sends nothing', async () => {
    const email = `kyc-race-submit-first-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email });
    const admin = await asAdmin(appGated.app);
    const submit = await holdAdvancedSubmitLock(userId, async () => {
      await db()
        .insert(kycVerification)
        .values({
          userId,
          provider: 'e2e-vendor',
          referenceId: `e2e-${randomUUID()}`,
          tier: 'advanced',
          status: 'pending',
          documentTypes: ['passport'],
          triggeredBy: 'submission',
        });
    });

    const request = admin.post(`/compliance/players/${userId}/kyc/resubmit`, {
      tier: 'advanced',
      reason: 'racing request',
    });
    await waitForRequestParkedOnSubmitLock(userId);
    await submit.release();

    const res = await request;
    expect(res.status).toBe(409);
    expect((await readJson(res)).message).toContain('override the tier KYC status');
    expect(await advancedStatuses(userId)).toEqual(['pending']);
    expect(await resubmissionRequestEvents(db(), userId)).toHaveLength(0);
    expect(await resubmissionNotifications(client)).toHaveLength(0);
    expect(resubmissionEmails(email)).toHaveLength(0);
  });

  it('a request that takes the lock first is written and notified, and the submit after it opens a new session', async () => {
    const email = `kyc-race-request-first-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerAndMaterializePlayer(appGated, { email });
    const admin = await asAdmin(appGated.app);
    const hold = await holdAdvancedSubmitLock(userId, async () => {});

    const request = admin.post(`/compliance/players/${userId}/kyc/resubmit`, {
      tier: 'advanced',
      reason: 'racing request',
    });
    await waitForRequestParkedOnSubmitLock(userId);
    await hold.release();
    const res = await request;
    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ status: 'resubmission_requested' });
    // The outbox read the refusal tests rely on sees a request that did emit.
    expect(await resubmissionRequestEvents(db(), userId)).toHaveLength(1);

    const submit = await client.post('/compliance/kyc', {
      tier: 'advanced',
      documents: [{ type: 'passport', frontUrl: 'https://example.test/front.jpg' }],
    });
    expect(submit.status).toBe(200);
    expect(await advancedStatuses(userId)).toEqual(['resubmission_requested', 'pending']);
    await vi.waitFor(async () => {
      expect(await resubmissionNotifications(client)).toHaveLength(1);
      expect(resubmissionEmails(email)).toHaveLength(1);
    }, PIPELINE_WAIT);
  });
});
