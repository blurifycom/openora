import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  EVENT_BUS,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { JOB_QUEUE, queue } from '@openora/core/contracts';
import { session } from '@openora/core/pam/schema/identity';
import { walletTransaction } from '@openora/core/wallet/schema';
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
 * E2E for player tagging - automatic wallet-based tags, over real HTTP + Postgres.
 * Covers: withdrawal_review assign-on-request, dormant_high_roller co-occurrence sweep +
 * login removal, high_risk resweep (frequency-only removal, amount-only never-resweep),
 * authz on the 6 previously-unguarded tag routes, and audit entries for automated ops.
 */

let db: TestDb;
let app: TestApp;
let admin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function registerAndMaterializePlayer(honoApp: TestApp['app'], email: string) {
  const registerRes = await honoApp.request('/identity/register', {
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
  if (!registerRes.ok) {
    throw new Error(`register failed (${registerRes.status}): ${await registerRes.text()}`);
  }
  const client = await asPlayer(honoApp, { email });
  const profileRes = await client.get('/profile');
  if (!profileRes.ok) {
    throw new Error(
      `profile materialize failed (${profileRes.status}): ${await profileRes.text()}`,
    );
  }
  const profile = (await profileRes.json()) as { id: string; userId: string };
  return { client, playerId: profile.id, userId: profile.userId };
}

async function backdateSessions(
  container: Container<CoreTokenCatalog>,
  userId: string,
  daysAgo: number,
) {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await container
    .get(DRIZZLE)
    .db.update(session)
    .set({ createdAt: past })
    .where(eq(session.userId, userId));
}

async function backdateTransaction(
  container: Container<CoreTokenCatalog>,
  transactionId: string,
  daysAgo: number,
) {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await container
    .get(DRIZZLE)
    .db.update(walletTransaction)
    .set({ createdAt: past })
    .where(eq(walletTransaction.id, transactionId));
}

async function activeTagKeys(admin: TestClient, playerId: string): Promise<string[]> {
  const res = await admin.get(`/player/${playerId}/player-tag?page=1&limit=50`);
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return (body.items as Array<{ tag: { key: string } }>).map((i) => i.tag.key);
}

async function upsertRule(admin: TestClient, tagKey: string, input: Record<string, unknown>) {
  const res = await admin.put(`/tag-rule/${tagKey}`, input);
  if (res.status !== 200) {
    throw new Error(`upsertRule(${tagKey}) failed (${res.status}): ${await res.text()}`);
  }
  return res;
}

async function assignTagManually(admin: TestClient, playerId: string, tagKey: string) {
  const res = await admin.post(`/player/${playerId}/player-tag`, {
    tagKey,
    assignReason: 'qa e2e fixture - manual seed',
    assignActor: 'manual',
  });
  if (res.status !== 200) {
    throw new Error(`assignTagManually(${tagKey}) failed (${res.status}): ${await res.text()}`);
  }
  return readJson(res);
}

async function runDailySweep(container: Container<CoreTokenCatalog>) {
  await container.get(JOB_QUEUE).enqueue(queue('tag.daily-evaluation'), {});
}

async function auditHasEntry(admin: TestClient, playerId: string, action: string) {
  await vi.waitFor(async () => {
    const res = await admin.get(`/audit/logs?resourceId=${playerId}&action=${action}`);
    const body = await readJson(res);
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  // Reuse one admin session across the file; the identity login rate limit is
  // intentionally bounded and this suite performs many admin requests.
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('withdrawal_review: assign on wallet.withdrawal.requested', () => {
  it('assigns the tag when a withdrawal attempt meets the threshold, not below it', async () => {
    await upsertRule(admin, 'withdrawal_review', {
      isEnabled: true,
      threshold: '500',
      thresholdDays: null,
      thresholdCount: null,
    });

    const belowEmail = `wr-below-${randomUUID()}@e2e.test`;
    const { client: belowClient, playerId: belowPlayerId } = await registerAndMaterializePlayer(
      app.app,
      belowEmail,
    );
    await belowClient.post('/wallet/deposit', { amount: '1000', currency: 'USD' });
    const belowRes = await belowClient.post('/wallet/withdraw', { amount: '499', currency: 'USD' });
    expect(belowRes.status).toBe(200);

    const aboveEmail = `wr-above-${randomUUID()}@e2e.test`;
    const { client: aboveClient, playerId: abovePlayerId } = await registerAndMaterializePlayer(
      app.app,
      aboveEmail,
    );
    await aboveClient.post('/wallet/deposit', { amount: '1000', currency: 'USD' });
    const aboveRes = await aboveClient.post('/wallet/withdraw', {
      amount: '500',
      currency: 'USD',
    });
    expect(aboveRes.status).toBe(200);

    await vi.waitFor(async () => {
      const tags = await activeTagKeys(admin, abovePlayerId);
      expect(tags).toContain('withdrawal_review');
    });
    await auditHasEntry(admin, abovePlayerId, 'tag.player.assigned');

    // Below-threshold player never gets the tag - give the async handler a beat, then assert absence.
    await new Promise((r) => setTimeout(r, 300));
    const belowTags = await activeTagKeys(admin, belowPlayerId);
    expect(belowTags).not.toContain('withdrawal_review');
  });

  it('is sticky - the withdrawal completing afterwards never removes it (no automated removal path exists)', async () => {
    const email = `wr-sticky-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(app.app, email);
    await client.post('/wallet/deposit', { amount: '1000', currency: 'USD' });
    const res = await client.post('/wallet/withdraw', { amount: '500', currency: 'USD' });
    expect(res.status).toBe(200);
    const body = await readJson(res);

    await vi.waitFor(async () => {
      expect(await activeTagKeys(admin, playerId)).toContain('withdrawal_review');
    });

    // Admin-approve the withdrawal (wallet.withdrawal.completed fires) and re-run the daily
    // sweep - neither path in tag-evaluation.service.ts touches withdrawal_review at all.
    if (body.status === 'pending') {
      const approveRes = await admin.post(`/wallet/withdrawals/${body.transactionId}/approve`, {
        withdrawalId: body.transactionId,
      });
      expect(approveRes.status).toBe(200);
    }
    await runDailySweep(app.container);
    await new Promise((r) => setTimeout(r, 300));
    expect(await activeTagKeys(admin, playerId)).toContain('withdrawal_review');
  });
});

describe('dormant_high_roller: co-occurrence sweep + login removal', () => {
  it('assigns only to inactive players who also hold high_roller, then removes on login without touching high_roller', async () => {
    await upsertRule(admin, 'dormant_high_roller', {
      isEnabled: true,
      threshold: null,
      thresholdDays: 30,
      thresholdCount: null,
    });

    const hrEmail = `dhr-hr-${randomUUID()}@e2e.test`;
    const {
      client: hrClient,
      playerId: hrPlayerId,
      userId: hrUserId,
    } = await registerAndMaterializePlayer(app.app, hrEmail);
    await assignTagManually(admin, hrPlayerId, 'high_roller');
    await backdateSessions(app.container, hrUserId, 40);

    const plainEmail = `dhr-plain-${randomUUID()}@e2e.test`;
    const { playerId: plainPlayerId, userId: plainUserId } = await registerAndMaterializePlayer(
      app.app,
      plainEmail,
    );
    await backdateSessions(app.container, plainUserId, 40);

    await runDailySweep(app.container);

    await vi.waitFor(async () => {
      expect(await activeTagKeys(admin, hrPlayerId)).toEqual(
        expect.arrayContaining(['high_roller', 'dormant_high_roller']),
      );
    });
    await auditHasEntry(admin, hrPlayerId, 'tag.player.assigned');

    const plainTags = await activeTagKeys(admin, plainPlayerId);
    expect(plainTags).not.toContain('dormant_high_roller');

    // Login removes dormant_high_roller but leaves high_roller untouched.
    await asPlayer(app.app, { email: hrEmail });
    await vi.waitFor(async () => {
      const tags = await activeTagKeys(admin, hrPlayerId);
      expect(tags).toContain('high_roller');
      expect(tags).not.toContain('dormant_high_roller');
    });
    await auditHasEntry(admin, hrPlayerId, 'tag.player.removed');

    void hrClient; // registered client not otherwise used past setup
  });

  it('rule disabled: sweep takes no action for the tag', async () => {
    await upsertRule(admin, 'dormant_high_roller', {
      isEnabled: false,
      threshold: null,
      thresholdDays: 30,
      thresholdCount: null,
    });

    const email = `dhr-disabled-${randomUUID()}@e2e.test`;
    const { playerId, userId } = await registerAndMaterializePlayer(app.app, email);
    await assignTagManually(admin, playerId, 'high_roller');
    await backdateSessions(app.container, userId, 40);

    await runDailySweep(app.container);
    await new Promise((r) => setTimeout(r, 300));
    expect(await activeTagKeys(admin, playerId)).not.toContain('dormant_high_roller');

    // restore for later tests
    await upsertRule(admin, 'dormant_high_roller', {
      isEnabled: true,
      threshold: null,
      thresholdDays: 30,
      thresholdCount: null,
    });
  });
});

describe('high_risk: existing assign path unaffected, frequency-only resweep', () => {
  it('amount-only rule (no thresholdDays/thresholdCount): the daily sweep never resweeps/removes it', async () => {
    await upsertRule(admin, 'high_risk', {
      isEnabled: true,
      threshold: '999999',
      thresholdDays: null,
      thresholdCount: null,
    });

    const email = `hr-amountonly-${randomUUID()}@e2e.test`;
    const { playerId } = await registerAndMaterializePlayer(app.app, email);
    await assignTagManually(admin, playerId, 'high_risk');

    await runDailySweep(app.container);
    await new Promise((r) => setTimeout(r, 300));
    expect(await activeTagKeys(admin, playerId)).toContain('high_risk');
  });

  it('assigns via withdrawal count breach (existing path), then the resweep removes it once the window ages the withdrawals out', async () => {
    await upsertRule(admin, 'high_risk', {
      isEnabled: true,
      threshold: '999999',
      thresholdDays: 7,
      thresholdCount: 2,
    });

    const email = `hr-freq-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(app.app, email);
    await client.post('/wallet/deposit', { amount: '100', currency: 'USD' });

    const w1 = await readJson(
      await client.post('/wallet/withdraw', { amount: '5', currency: 'USD' }),
    );
    const w2 = await readJson(
      await client.post('/wallet/withdraw', { amount: '5', currency: 'USD' }),
    );

    // appDefault has autoWithdrawal off - withdrawals stay pending until approved. The
    // count query filters on status='completed', so approve both to make them count.
    for (const w of [w1, w2]) {
      if (w.status === 'pending') {
        const res = await admin.post(`/wallet/withdrawals/${w.transactionId}/approve`, {
          withdrawalId: w.transactionId,
        });
        expect(res.status).toBe(200);
      }
    }

    await vi.waitFor(async () => {
      expect(await activeTagKeys(admin, playerId)).toContain('high_risk');
    });
    await auditHasEntry(admin, playerId, 'tag.player.assigned');

    // Age both withdrawals out of the 7-day window, then resweep.
    await backdateTransaction(app.container, w1.transactionId, 10);
    await backdateTransaction(app.container, w2.transactionId, 10);
    await runDailySweep(app.container);

    await vi.waitFor(async () => {
      expect(await activeTagKeys(admin, playerId)).not.toContain('high_risk');
    });
    await auditHasEntry(admin, playerId, 'tag.player.removed');
  });
});

describe('idempotency: at-least-once event delivery does not throw', () => {
  it('re-emitting wallet.withdrawal.requested for an already-tagged player does not throw (literal AC wording)', async () => {
    await upsertRule(admin, 'withdrawal_review', {
      isEnabled: true,
      threshold: '500',
      thresholdDays: null,
      thresholdCount: null,
    });

    const email = `idem-wr-${randomUUID()}@e2e.test`;
    const { userId, playerId } = await registerAndMaterializePlayer(app.app, email);

    const eventBus = app.container.get(EVENT_BUS);
    const payload = {
      userId,
      playerId: null,
      amount: '600',
      currency: 'USD',
      transactionId: randomUUID(),
    };
    eventBus.emit('wallet.withdrawal.requested', payload);
    eventBus.emit('wallet.withdrawal.requested', payload);

    // The AC's literal wording ("must not throw") holds - the app stays up and the tag
    // is visible either way. It also now holds that exactly one active row results:
    // the `player_tag_active_key` partial unique index (packages/core/src/pam/tag/schema/index.ts)
    // makes the second delivery's insert a no-op, and `tryAssignTag` swallows the
    // resulting TagAlreadyInUseError as an idempotent no-op - see the race-repro
    // case right below for the deterministic concurrent version of this guarantee.
    await vi.waitFor(async () => {
      const tags = await activeTagKeys(admin, playerId);
      expect(tags).toContain('withdrawal_review');
    });
    const tags = await activeTagKeys(admin, playerId);
    expect(tags.filter((k) => k === 'withdrawal_review')).toHaveLength(1);
  });

  it('exactly one of 5 concurrent assignPlayerTag calls succeeds; the rest are rejected as a conflict (race repro, fixed by the player_tag_active_key unique index)', async () => {
    const email = `race-assign-${randomUUID()}@e2e.test`;
    const { playerId } = await registerAndMaterializePlayer(app.app, email);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        admin.post(`/player/${playerId}/player-tag`, {
          tagKey: 'vip',
          assignReason: 'race repro - concurrent assign',
          assignActor: 'manual',
        }),
      ),
    );
    const statuses = results.map((r) => r.status);
    const successCount = statuses.filter((s) => s === 200).length;
    const conflictCount = statuses.filter((s) => s === 409).length;

    const tags = await activeTagKeys(admin, playerId);
    const vipCount = tags.filter((k) => k === 'vip').length;

    // The player_tag_active_key partial unique index (tagId, playerId WHERE removedAt
    // IS NULL) makes assignPlayerTag's insert the real source of truth under
    // concurrency: exactly one racer wins the insert, the other 4 lose the
    // onConflictDoNothing race and surface as TagAlreadyInUseError -> HTTP 409
    // (packages/core/src/pam/tag/router/index.ts's mapErrors wiring).
    process.stderr.write(
      `[race repro] statuses=${JSON.stringify(statuses)} successCount=${successCount} activeVipRows=${vipCount}\n`,
    );
    expect(successCount).toBe(1);
    expect(conflictCount).toBe(4);
    expect(vipCount).toBe(1);
  });

  it('re-emitting identity.user.login for a player with no dormant_high_roller/inactive tag does not throw', async () => {
    const email = `idem-login-${randomUUID()}@e2e.test`;
    const { userId } = await registerAndMaterializePlayer(app.app, email);

    const eventBus = app.container.get(EVENT_BUS);
    eventBus.emit('identity.user.login', { userId, playerId: null });
    eventBus.emit('identity.user.login', { userId, playerId: null });

    // No assertion beyond "did not crash the process" - tryRemoveTag swallows
    // TagAssignmentNotFoundError; give the async handlers a beat to run.
    await new Promise((r) => setTimeout(r, 300));
    expect(true).toBe(true);
  });
});

describe('authz: the 6 previously-unguarded tag routes', () => {
  it('rejects unauthenticated callers with 401 on all 6 routes', async () => {
    const playerId = randomUUID();
    const anon = app.app;

    const createRes = await anon.request('/tag', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'high_roller', isSticky: false }),
    });
    expect(createRes.status).toBe(401);

    const deleteRes = await anon.request('/tag/high_roller', { method: 'DELETE' });
    expect(deleteRes.status).toBe(401);

    const listPlayerTagsRes = await anon.request(`/player/${playerId}/player-tag?page=1&limit=20`);
    expect(listPlayerTagsRes.status).toBe(401);

    const assignRes = await anon.request(`/player/${playerId}/player-tag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tagKey: 'high_roller',
        assignReason: 'anon attempt',
        assignActor: 'manual',
      }),
    });
    expect(assignRes.status).toBe(401);

    const removeRes = await anon.request(`/player/${playerId}/player-tag/high_roller`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removalReason: 'anon attempt', removalActor: 'manual' }),
    });
    expect(removeRes.status).toBe(401);

    const listAssignableRes = await anon.request(`/player/${playerId}/assignable-tags`);
    expect(listAssignableRes.status).toBe(401);
  });

  it('rejects an authenticated non-admin player with 403 on all 6 routes, and a legitimate admin succeeds (positive control)', async () => {
    const email = `authz-player-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(app.app, email);
    // Default role after registration is 'player' - explicitly not admin/support/content-manager.

    const createRes = await client.post('/tag', { key: 'vip', isSticky: true });
    expect(createRes.status).toBe(403);

    const deleteRes = await client.del('/tag/vip');
    expect(deleteRes.status).toBe(403);

    const listPlayerTagsRes = await client.get(`/player/${playerId}/player-tag?page=1&limit=20`);
    expect(listPlayerTagsRes.status).toBe(403);

    const assignRes = await client.post(`/player/${playerId}/player-tag`, {
      tagKey: 'high_roller',
      assignReason: 'self attempt',
      assignActor: 'manual',
    });
    expect(assignRes.status).toBe(403);

    const removeRes = await client.request(`/player/${playerId}/player-tag/high_roller`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removalReason: 'self attempt', removalActor: 'manual' }),
    });
    expect(removeRes.status).toBe(403);

    const listAssignableRes = await client.get(`/player/${playerId}/assignable-tags`);
    expect(listAssignableRes.status).toBe(403);

    // Positive control: a legitimate admin session succeeds on listPlayerTags and
    // listAssignableTags for the same player - proves the guard isn't too broad.
    const adminListRes = await admin.get(`/player/${playerId}/player-tag?page=1&limit=20`);
    expect(adminListRes.status).toBe(200);
    const adminAssignableRes = await admin.get(`/player/${playerId}/assignable-tags`);
    expect(adminAssignableRes.status).toBe(200);
  });

  it('players never see their own tags: a non-admin player cannot read tags even on their own profile', async () => {
    const email = `authz-selfread-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(app.app, email);
    await assignTagManually(admin, playerId, 'vip');

    const res = await client.get(`/player/${playerId}/player-tag?page=1&limit=20`);
    expect(res.status).toBe(403);
  });
});
