import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { JOB_QUEUE, PLAY_ELIGIBILITY, queue } from '@openora/core/contracts';
import { rgExclusion } from '@openora/core/compliance/schema';
import { user } from '@openora/core/pam/schema/identity';
import {
  setupTestDb,
  bootTestApp,
  registrationRequestHeaders,
  asPlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * End-to-end coverage for Responsible Gambling (write surface + read/monitoring
 * surface), driven over real HTTP against the real Hono + oRPC app
 * (bootTestApp) and a real Postgres test db. Mirrors kyc.e2e.test.ts.
 *
 * Two testing techniques used throughout (both applied to the real DB rows the
 * app itself wrote, never bypassing the app for the action under test):
 * - `expireExclusion` reaches into the DB to move a real exclusion's `expiresAt`
 *   into the past, standing in for the passage of a 6-month/24h clock.
 * - `triggerRgMonitorSweep` enqueues the same `rg-monitor` job the 60s recurring
 *   schedule would fire, so the background sweep (expire lapsed cooling-off +
 *   recompute enforcement) runs deterministically instead of on a real timer.
 */

const JOB_WAIT = { timeout: 15000, interval: 100 };

let db: TestDb;
let app: TestApp;
let admin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function registerPlayer(email: string) {
  const res = await app.app.request('/identity/register', {
    method: 'POST',
    headers: registrationRequestHeaders(),
    body: JSON.stringify({
      email,
      password: 'password123',
      username: `player_${randomUUID().replaceAll('-', '').slice(0, 12)}`,
      acceptedTerms: true,
      acceptedAge: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`register failed (${res.status}): ${await res.text()}`);
  }
  const client = await asPlayer(app.app, { email });
  // Materialize the PAM player row (get-or-create) so RG actions taken against this
  // user resolve to a real player.id for the audit trail - see audit/plugin.ts
  // mapEventToRecord's resolvePlayerId.
  const profileRes = await client.get('/profile');
  const profile = (await profileRes.json()) as { id: string };
  const [registered] = await app.container
    .get(DRIZZLE)
    .db.select({ id: user.id })
    .from(user)
    .where(eq(user.email, email));
  if (!registered) {
    throw new Error('registered user was not persisted');
  }
  return { client, userId: registered.id, playerId: profile.id };
}

async function attemptLogin(email: string, password: string) {
  return app.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
}

async function setRole(container: Container<CoreTokenCatalog>, userId: string, role: string) {
  await container.get(DRIZZLE).db.update(user).set({ role }).where(eq(user.id, userId));
}

async function expireExclusion(container: Container<CoreTokenCatalog>, exclusionId: string) {
  await container
    .get(DRIZZLE)
    .db.update(rgExclusion)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(eq(rgExclusion.id, exclusionId));
}

async function exclusionStatus(container: Container<CoreTokenCatalog>, exclusionId: string) {
  const [row] = await container
    .get(DRIZZLE)
    .db.select({ status: rgExclusion.status })
    .from(rgExclusion)
    .where(eq(rgExclusion.id, exclusionId));
  return row?.status;
}

async function triggerRgMonitorSweep(container: Container<CoreTokenCatalog>) {
  await container.get(JOB_QUEUE).enqueue(queue('rg-monitor'), {});
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  // Logged in once and reused across every test in this file - 15 per-test asAdmin()
  // logins would trip the identity module's login rate limit (10/5min/email).
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('RG limits, cooling-off, self-exclusion happy path', () => {
  it('sets a deposit + session-time limit, reads them back via getRgSection', async () => {
    const { userId } = await registerPlayer(`rg-limits-${randomUUID()}@e2e.test`);

    const depositRes = await admin.put(`/compliance/players/${userId}/limits`, {
      type: 'deposit',
      amount: '500',
      minutes: null,
      period: 'daily',
    });
    expect(depositRes.status).toBe(200);
    expect((await readJson(depositRes)).amount).toBe('500.00');

    const sessionRes = await admin.put(`/compliance/players/${userId}/limits`, {
      type: 'session',
      amount: null,
      minutes: 60,
      period: 'session',
    });
    expect(sessionRes.status).toBe(200);

    const sectionRes = await admin.get(`/compliance/players/${userId}/rg`);
    expect(sectionRes.status).toBe(200);
    const section = await readJson(sectionRes);
    expect(section.limits).toHaveLength(2);
    expect(section.limits.map((l: { type: string }) => l.type).sort()).toEqual([
      'deposit',
      'session',
    ]);
    expect(section.coolingOff).toBeNull();
    expect(section.selfExclusion).toBeNull();
  });

  it('activates a 24h cooling-off and surfaces it via getRgSection', async () => {
    const { userId } = await registerPlayer(`rg-cooloff-${randomUUID()}@e2e.test`);

    const res = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'player requested a break',
    });
    expect(res.status).toBe(200);
    const body = await readJson(res);
    expect(body.status).toBe('active');
    expect(body.isPermanent).toBe(false);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const section = await readJson(await admin.get(`/compliance/players/${userId}/rg`));
    expect(section.coolingOff).toMatchObject({ id: body.id, status: 'active' });
  });

  it('activates a fixed-term (6mo) and a permanent self-exclusion on different players', async () => {
    const fixed = await registerPlayer(`rg-selfexcl-fixed-${randomUUID()}@e2e.test`);
    const permanent = await registerPlayer(`rg-selfexcl-perm-${randomUUID()}@e2e.test`);

    const fixedRes = await admin.post(`/compliance/players/${fixed.userId}/self-exclusion`, {
      isPermanent: false,
      durationMonths: 6,
      reason: 'player requested',
      confirm: true,
    });
    expect(fixedRes.status).toBe(200);
    const fixedBody = await readJson(fixedRes);
    expect(fixedBody.isPermanent).toBe(false);
    expect(fixedBody.expiresAt).not.toBeNull();
    // ~6 months out, well past the 6-week cooling-off ceiling.
    expect(new Date(fixedBody.expiresAt).getTime()).toBeGreaterThan(
      Date.now() + 150 * 24 * 60 * 60 * 1000,
    );

    const permRes = await admin.post(`/compliance/players/${permanent.userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(permRes.status).toBe(200);
    const permBody = await readJson(permRes);
    expect(permBody.isPermanent).toBe(true);
    expect(permBody.expiresAt).toBeNull();
  });

  it('lifts a fixed-term self-exclusion once the minimum period has elapsed', async () => {
    const { userId } = await registerPlayer(`rg-lift-${randomUUID()}@e2e.test`);

    const activateRes = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: false,
      durationMonths: 6,
      reason: 'player requested',
      confirm: true,
    });
    expect(activateRes.status).toBe(200);
    const exclusionId = (await readJson(activateRes)).id as string;

    await expireExclusion(app.container, exclusionId);

    const liftRes = await admin.post(`/compliance/players/${userId}/self-exclusion/lift`, {
      reason: 'minimum period elapsed, player requested reinstatement',
      confirm: true,
    });
    expect(liftRes.status).toBe(200);
    const lifted = await readJson(liftRes);
    expect(lifted.status).toBe('lifted');
    expect(lifted.liftedReason).toBe('minimum period elapsed, player requested reinstatement');
  });
});

describe('RG self-exclusion leaves player funds unlocked', () => {
  it('keeps a pending withdrawal in the admin queue and approvable after the exclusion lands', async () => {
    const email = `rg-withdraw-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerPlayer(email);

    const depositRes = await client.post('/wallet/deposit', { amount: '50', currency: 'USD' });
    expect(depositRes.status).toBe(200);
    const withdrawRes = await client.post('/wallet/withdraw', { amount: '20', currency: 'USD' });
    expect(withdrawRes.status).toBe(200);
    const withdrawalId = (await readJson(withdrawRes)).transactionId as string;

    const exclusionRes = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(exclusionRes.status).toBe(200);

    const queueRes = await admin.get('/wallet/withdrawals?status=pending&currency=USD&limit=100');
    expect(queueRes.status).toBe(200);
    const queued = (await readJson(queueRes)).items as Array<{ transactionId: string }>;
    expect(queued.map((i) => i.transactionId)).toContain(withdrawalId);

    const approveRes = await admin.post(`/wallet/withdrawals/${withdrawalId}/approve`, {});
    expect(approveRes.status).toBe(200);
    expect((await readJson(approveRes)).status).not.toBe('pending');
  });
});

describe('RG login enforcement', () => {
  it('blocks login + revokes sessions after cooling-off; wrong password stays indistinguishable pre-auth', async () => {
    const email = `rg-enforce-cooloff-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerPlayer(email);

    const preBlockRes = await client.get('/profile');
    expect(preBlockRes.status).toBe(200);

    const wrongPwBefore = await attemptLogin(email, 'not-the-password');
    expect(wrongPwBefore.status).toBe(401);
    const wrongPwBeforeBody = await readJson(wrongPwBefore);

    const coolOffRes = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'RG monitoring flag',
    });
    expect(coolOffRes.status).toBe(200);

    const blockedLoginRes = await attemptLogin(email, 'password123');
    expect(blockedLoginRes.status).toBe(403);

    const revokedSessionRes = await client.get('/profile');
    expect(revokedSessionRes.status).toBe(401);

    const wrongPwAfter = await attemptLogin(email, 'not-the-password');
    expect(wrongPwAfter.status).toBe(401);
    const wrongPwAfterBody = await readJson(wrongPwAfter);
    // Credentials are checked before the RG reason is surfaced: a wrong-password
    // attempt on a blocked account must look exactly like an ordinary wrong-password
    // failure, both before and after the block took effect.
    expect(wrongPwAfterBody.message).toBe(wrongPwBeforeBody.message);
  });

  it('blocks login + revokes sessions after self-exclusion', async () => {
    const email = `rg-enforce-selfexcl-${randomUUID()}@e2e.test`;
    const { client, userId } = await registerPlayer(email);

    expect((await client.get('/profile')).status).toBe(200);

    const res = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(res.status).toBe(200);

    const blockedLoginRes = await attemptLogin(email, 'password123');
    expect(blockedLoginRes.status).toBe(403);
    const blockedBody = await readJson(blockedLoginRes);
    expect(String(blockedBody.message).toLowerCase()).toContain('responsible gambling');

    expect((await client.get('/profile')).status).toBe(401);

    const wrongPwRes = await attemptLogin(email, 'not-the-password');
    expect(wrongPwRes.status).toBe(401);
    const wrongPwBody = await readJson(wrongPwRes);
    expect(String(wrongPwBody.message).toLowerCase()).not.toContain('gambling');
  });
});

describe('RG cooling-off lift', () => {
  const isRestricted = (userId: string) => app.container.get(PLAY_ELIGIBILITY).isRestricted(userId);

  it('restores login and play when an admin lifts an active cooling-off early', async () => {
    const email = `rg-cooloff-lift-${randomUUID()}@e2e.test`;
    const { userId } = await registerPlayer(email);

    const activateRes = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 1008,
      reason: 'activated on the wrong player',
    });
    expect(activateRes.status).toBe(200);
    const exclusionId = (await readJson(activateRes)).id as string;

    expect((await attemptLogin(email, 'password123')).status).toBe(403);
    await expect(isRestricted(userId)).resolves.toBe(true);

    const liftRes = await admin.post(`/compliance/players/${userId}/cooling-off/lift`, {
      reason: 'raised in error, support ticket 42',
    });
    expect(liftRes.status).toBe(200);
    const lifted = await readJson(liftRes);
    expect(lifted.status).toBe('lifted');
    expect(lifted.liftedReason).toBe('raised in error, support ticket 42');
    expect(await exclusionStatus(app.container, exclusionId)).toBe('lifted');

    expect((await attemptLogin(email, 'password123')).status).toBe(200);
    await expect(isRestricted(userId)).resolves.toBe(false);

    const section = await readJson(await admin.get(`/compliance/players/${userId}/rg`));
    expect(section.coolingOff).toBeNull();
  });

  it('keeps the player blocked when a self-exclusion is still active', async () => {
    const email = `rg-cooloff-lift-se-${randomUUID()}@e2e.test`;
    const { userId } = await registerPlayer(email);

    await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'short break',
    });
    await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });

    const liftRes = await admin.post(`/compliance/players/${userId}/cooling-off/lift`, {
      reason: 'superseded by the self-exclusion',
    });
    expect(liftRes.status).toBe(200);

    expect((await attemptLogin(email, 'password123')).status).toBe(403);
    await expect(isRestricted(userId)).resolves.toBe(true);
  });

  it('rejects lifting when the player has no active cooling-off', async () => {
    const { userId } = await registerPlayer(`rg-cooloff-lift-none-${randomUUID()}@e2e.test`);

    const res = await admin.post(`/compliance/players/${userId}/cooling-off/lift`, {
      reason: 'nothing to lift',
    });
    expect(res.status).toBe(404);
  });

  it('records the lift in the audit trail with actor, reason and subject', async () => {
    const { userId, playerId } = await registerPlayer(
      `rg-cooloff-lift-audit-${randomUUID()}@e2e.test`,
    );

    await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'player requested a break',
    });
    await admin.post(`/compliance/players/${userId}/cooling-off/lift`, {
      reason: 'player changed their mind',
    });

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=rg.cooling_off.lifted`,
      );
      const body = await readJson(res);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actorType).toBe('admin');
      expect(body.items[0].resourceType).toBe('player');
      expect(body.items[0].before).toMatchObject({ status: 'active' });
      expect(body.items[0].after).toMatchObject({ reason: 'player changed their mind' });
    });
  });
});

describe('RG self-exclusion lift negatives', () => {
  it('rejects lifting before the minimum period elapses', async () => {
    const { userId } = await registerPlayer(`rg-lift-early-${randomUUID()}@e2e.test`);

    const activateRes = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: false,
      durationMonths: 6,
      reason: 'player requested',
      confirm: true,
    });
    expect(activateRes.status).toBe(200);

    const liftRes = await admin.post(`/compliance/players/${userId}/self-exclusion/lift`, {
      reason: 'trying too early',
      confirm: true,
    });
    expect(liftRes.status).toBe(409);
  });

  it('rejects lifting a permanent self-exclusion, even long after activation', async () => {
    const { userId } = await registerPlayer(`rg-lift-permanent-${randomUUID()}@e2e.test`);

    const activateRes = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(activateRes.status).toBe(200);

    const liftRes = await admin.post(`/compliance/players/${userId}/self-exclusion/lift`, {
      reason: 'player changed their mind',
      confirm: true,
    });
    expect(liftRes.status).toBe(409);
  });

  it('requires reason + confirm:true on the lift', async () => {
    const { userId } = await registerPlayer(`rg-lift-shape-${randomUUID()}@e2e.test`);

    await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: false,
      durationMonths: 6,
      reason: 'player requested',
      confirm: true,
    });

    const missingReasonRes = await admin.post(`/compliance/players/${userId}/self-exclusion/lift`, {
      reason: '',
      confirm: true,
    });
    expect(missingReasonRes.status).toBeGreaterThanOrEqual(400);
    expect(missingReasonRes.status).toBeLessThan(500);

    const missingConfirmRes = await admin.post(
      `/compliance/players/${userId}/self-exclusion/lift`,
      { reason: 'a good reason', confirm: false },
    );
    expect(missingConfirmRes.status).toBeGreaterThanOrEqual(400);
    expect(missingConfirmRes.status).toBeLessThan(500);
  });
});

describe('RG regression: a permanent self-exclusion outlives a lapsed cooling-off', () => {
  it('keeps the login block after a subsequent short cooling-off expires, and allows re-activating cooling-off', async () => {
    const email = `rg-regression-${randomUUID()}@e2e.test`;
    const { userId } = await registerPlayer(email);

    const permRes = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(permRes.status).toBe(200);
    expect((await attemptLogin(email, 'password123')).status).toBe(403);

    const coolOffRes = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'also flagged for a short cooling-off',
    });
    expect(coolOffRes.status).toBe(200);
    const coolOffId = (await readJson(coolOffRes)).id as string;

    // Still blocked immediately after adding the cooling-off - the permanent
    // self-exclusion must win the recompute, not be downgraded to a finite block.
    expect((await attemptLogin(email, 'password123')).status).toBe(403);

    await expireExclusion(app.container, coolOffId);
    await triggerRgMonitorSweep(app.container);

    await vi.waitFor(async () => {
      expect(await exclusionStatus(app.container, coolOffId)).toBe('expired');
    });

    // The cooling-off lapsed and was swept to `expired` - the permanent
    // self-exclusion block must still hold.
    expect((await attemptLogin(email, 'password123')).status).toBe(403);

    const section = await readJson(await admin.get(`/compliance/players/${userId}/rg`));
    expect(section.coolingOff).toBeNull();
    expect(section.selfExclusion).toMatchObject({ status: 'active', isPermanent: true });

    // A lapsed/expired cooling-off must not block a fresh one from being activated.
    const secondCoolOffRes = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 48,
      reason: 'second cooling-off after the first expired',
    });
    expect(secondCoolOffRes.status).toBe(200);
    expect((await readJson(secondCoolOffRes)).status).toBe('active');
  });
});

describe('RG authz negatives', () => {
  const validBodies: Record<string, unknown> = {
    limits: { type: 'deposit', amount: '100', minutes: null, period: 'daily' },
    coolingOff: { durationHours: 24, reason: 'x' },
    selfExclusion: { isPermanent: true, reason: 'x', confirm: true },
    lift: { reason: 'x', confirm: true },
  };

  it('rejects every RG route for an unauthenticated caller with 401', async () => {
    const userId = randomUUID();
    const routes: Array<[string, string, unknown?]> = [
      ['PUT', `/compliance/players/${userId}/limits`, validBodies['limits']],
      ['POST', `/compliance/players/${userId}/cooling-off`, validBodies['coolingOff']],
      ['POST', `/compliance/players/${userId}/self-exclusion`, validBodies['selfExclusion']],
      ['POST', `/compliance/players/${userId}/self-exclusion/lift`, validBodies['lift']],
      ['GET', `/compliance/players/${userId}/rg`],
      ['GET', `/compliance/rg-flags`],
    ];
    for (const [method, path, body] of routes) {
      const res = await app.app.request(path, {
        method,
        ...(body
          ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
          : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it('a support-role caller (view only) gets 403 on mutations, 200 on reads', async () => {
    const email = `rg-support-${randomUUID()}@e2e.test`;
    const { userId } = await registerPlayer(email);
    await setRole(app.container, userId, 'support');
    const support = await asPlayer(app.app, { email });
    const targetUserId = randomUUID();

    const mutationRoutes: Array<[string, string, unknown]> = [
      ['PUT', `/compliance/players/${targetUserId}/limits`, validBodies['limits']],
      ['POST', `/compliance/players/${targetUserId}/cooling-off`, validBodies['coolingOff']],
      ['POST', `/compliance/players/${targetUserId}/self-exclusion`, validBodies['selfExclusion']],
      ['POST', `/compliance/players/${targetUserId}/self-exclusion/lift`, validBodies['lift']],
    ];
    for (const [method, path, body] of mutationRoutes) {
      const res = await support.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status, `${method} ${path}`).toBe(403);
    }

    expect((await support.get(`/compliance/players/${targetUserId}/rg`)).status).toBe(200);
    expect((await support.get('/compliance/rg-flags')).status).toBe(200);
  });
});

describe('RG monitoring (queue-based)', () => {
  it('a deposit crossing 80% of a deposit limit raises a limit_threshold flag, filterable by type/period/date', async () => {
    const { client, userId } = await registerPlayer(`rg-monitor-deposit-${randomUUID()}@e2e.test`);

    const limitRes = await admin.put(`/compliance/players/${userId}/limits`, {
      type: 'deposit',
      amount: '100',
      minutes: null,
      period: 'daily',
    });
    expect(limitRes.status).toBe(200);

    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    const depositRes = await client.post('/wallet/deposit', { amount: '85', currency: 'USD' });
    expect(depositRes.status).toBe(200);

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/compliance/rg-flags?flagType=limit_threshold&limitType=deposit&fromDate=${yesterday}&toDate=${tomorrow}`,
      );
      const body = await readJson(res);
      const flag = body.items.find((i: { userId: string }) => i.userId === userId);
      expect(flag).toBeDefined();
      expect(flag.status).toBe('active');
      expect(flag.detail.pct).toBeGreaterThanOrEqual(80);
    }, JOB_WAIT);

    // Out of the date window - must not match.
    const farPastRes = await admin.get(
      `/compliance/rg-flags?flagType=limit_threshold&limitType=deposit&toDate=${new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()}`,
    );
    const farPastBody = await readJson(farPastRes);
    expect(farPastBody.items.find((i: { userId: string }) => i.userId === userId)).toBeUndefined();
  });

  it('a self-excluded login attempt raises a self_excluded_login flag', async () => {
    const email = `rg-monitor-login-${randomUUID()}@e2e.test`;
    const { userId } = await registerPlayer(email);

    const res = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(res.status).toBe(200);

    expect((await attemptLogin(email, 'password123')).status).toBe(403);

    await vi.waitFor(async () => {
      const listRes = await admin.get('/compliance/rg-flags?flagType=self_excluded_login');
      const body = await readJson(listRes);
      const flag = body.items.find((i: { userId: string }) => i.userId === userId);
      expect(flag).toBeDefined();
      expect(flag.detail.kind).toBe('self_exclusion');
    }, JOB_WAIT);
  });
});

describe('RG audit trail', () => {
  it('every RG mutation leaves an audit row with the right actor + before/after', async () => {
    const { userId, playerId } = await registerPlayer(`rg-audit-${randomUUID()}@e2e.test`);

    const limitRes = await admin.put(`/compliance/players/${userId}/limits`, {
      type: 'deposit',
      amount: '250',
      minutes: null,
      period: 'daily',
    });
    expect(limitRes.status).toBe(200);

    const coolOffRes = await admin.post(`/compliance/players/${userId}/cooling-off`, {
      durationHours: 24,
      reason: 'audit trail check',
    });
    expect(coolOffRes.status).toBe(200);
    const coolOffId = (await readJson(coolOffRes)).id as string;
    await expireExclusion(app.container, coolOffId);

    const selfExclRes = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: false,
      durationMonths: 6,
      reason: 'audit trail check',
      confirm: true,
    });
    expect(selfExclRes.status).toBe(200);
    const exclusionId = (await readJson(selfExclRes)).id as string;
    await expireExclusion(app.container, exclusionId);

    const liftRes = await admin.post(`/compliance/players/${userId}/self-exclusion/lift`, {
      reason: 'audit trail check lift',
      confirm: true,
    });
    expect(liftRes.status).toBe(200);

    await vi.waitFor(async () => {
      const res = await admin.get(`/audit/logs?resourceId=${playerId}&action=rg.limit.set`);
      const body = await readJson(res);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actorType).toBe('admin');
      expect(body.items[0].after).toMatchObject({ amount: '250', type: 'deposit' });
    });

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=rg.cooling_off.activated`,
      );
      const body = await readJson(res);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actorType).toBe('admin');
    });

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=rg.self_exclusion.activated`,
      );
      const body = await readJson(res);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actorType).toBe('admin');
      expect(body.items[0].after).toMatchObject({
        isPermanent: false,
        durationMonths: 6,
        reason: 'audit trail check',
        actorId: expect.any(String),
      });
      expect(body.items[0].after.expiresAt).toEqual(expect.any(String));
      expect(body.items[0].createdAt).toEqual(expect.any(String));
    });

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=rg.self_exclusion.lifted`,
      );
      const body = await readJson(res);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actorType).toBe('admin');
      expect(body.items[0].before).toMatchObject({ status: 'active' });
    });
  });

  it('records a system-actor audit row for a blocked login attempt', async () => {
    const email = `rg-audit-login-${randomUUID()}@e2e.test`;
    const { userId, playerId } = await registerPlayer(email);

    await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'audit login check',
      confirm: true,
    });
    expect((await attemptLogin(email, 'password123')).status).toBe(403);

    await vi.waitFor(async () => {
      const res = await admin.get(
        `/audit/logs?resourceId=${playerId}&action=rg.exclusion.login_blocked`,
      );
      const body = await readJson(res);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].actorType).toBe('system');
      expect(body.items[0].result).toBe('failure');
    });
  });

  it('exportCsv({actionPrefix: "rg."}) returns only rg.* rows', async () => {
    const { userId, playerId } = await registerPlayer(`rg-audit-export-${randomUUID()}@e2e.test`);

    const limitRes = await admin.put(`/compliance/players/${userId}/limits`, {
      type: 'wager',
      amount: '300',
      minutes: null,
      period: 'weekly',
    });
    expect(limitRes.status).toBe(200);

    await vi.waitFor(async () => {
      const res = await admin.get(`/audit/logs?resourceId=${playerId}&action=rg.limit.set`);
      expect((await readJson(res)).items).toHaveLength(1);
    });

    const exportRes = await admin.get(`/audit/export?actionPrefix=rg.&resourceId=${playerId}`);
    expect(exportRes.status).toBe(200);
    const { csv } = await readJson(exportRes);
    expect(csv).toContain('rg.limit.set');
    for (const line of csv.split('\n').slice(1).filter(Boolean)) {
      expect(line).toMatch(/rg\./);
    }
  });
});
