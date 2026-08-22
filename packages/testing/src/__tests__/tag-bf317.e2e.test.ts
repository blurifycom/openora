import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { rgExclusion } from '@openora/core/compliance/schema';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * E2E for BF-317: self_excluded auto-assign/remove on the RG self-exclusion lifecycle,
 * automatic multi_account + bonus_abuser tagging from identity login signals, the
 * seeded non-sticky level tag (single mutable row, atomic replace-on-change via
 * TagService.replacePlayerTag driven by player.level.changed), manual sticky-tag
 * cleanup, authz negatives, and the audit trail.
 */

const SYSTEM_ACTOR = '00000000-0000-0000-0000-000000000000';

let db: TestDb;
let app: TestApp;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function loginWithIp(honoApp: TestApp['app'], email: string, ip: string) {
  const loginRes = await honoApp.request('/identity/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-real-ip': ip,
      'user-agent': 'bf-317-e2e',
    },
    body: JSON.stringify({ email, password: 'password123' }),
  });
  if (!loginRes.ok) {
    throw new Error(`login failed (${loginRes.status}): ${await loginRes.text()}`);
  }
}

async function activeTags(
  admin: TestClient,
  playerId: string,
): Promise<Array<{ key: string; reason: string | null }>> {
  const res = await admin.get(`/player/${playerId}/player-tag?page=1&limit=50`);
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return (body.items as Array<{ tag: { key: string }; assignReason: string | null }>).map((i) => ({
    key: i.tag.key,
    reason: i.assignReason,
  }));
}

async function activeTagKeys(admin: TestClient, playerId: string): Promise<string[]> {
  return (await activeTags(admin, playerId)).map((t) => t.key);
}

async function backdateExclusionExpiry(
  container: Container<CoreTokenCatalog>,
  exclusionId: string,
  daysAgo: number,
) {
  const past = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  await container
    .get(DRIZZLE)
    .db.update(rgExclusion)
    .set({ expiresAt: past })
    .where(eq(rgExclusion.id, exclusionId));
}

async function auditEntries(admin: TestClient, resourceId: string, action: string) {
  const res = await admin.get(
    `/audit/logs?resourceId=${resourceId}&action=${encodeURIComponent(action)}`,
  );
  expect(res.status).toBe(200);
  const body = await readJson(res);
  return body.items as Array<{ actorType: string; actorId: string | null; action: string }>;
}

async function auditHasEntry(admin: TestClient, resourceId: string, action: string) {
  await vi.waitFor(async () => {
    const items = await auditEntries(admin, resourceId, action);
    expect(items.length).toBeGreaterThanOrEqual(1);
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
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('self_excluded: auto-assign/remove on rg.self_exclusion.activated/.lifted', () => {
  it('assigns self_excluded on activation, then removes it once lifted', async () => {
    const admin = await asAdmin(app.app);
    const email = `selfexcl-${randomUUID()}@e2e.test`;
    const { userId, playerId } = await registerAndMaterializePlayer(app, { email: email });

    const activateRes = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      userId,
      isPermanent: false,
      durationMonths: 6,
      reason: 'qa e2e - BF-317 self_excluded happy path',
      confirm: true,
    });
    expect(activateRes.status).toBe(200);
    const exclusion = await readJson(activateRes);

    await vi.waitFor(async () => {
      expect(await activeTagKeys(admin, playerId)).toContain('self_excluded');
    });
    await auditHasEntry(admin, playerId, 'tag.player.assigned');

    // durationMonths=6 minimum can't naturally elapse in a test run - backdate expiresAt
    // directly (same pattern as the sibling wallet-tag e2e suite's backdateSessions) so
    // liftSelfExclusion's ExclusionPeriodNotElapsedError guard passes.
    await backdateExclusionExpiry(app.container, exclusion.id, 1);

    const liftRes = await admin.post(`/compliance/players/${userId}/self-exclusion/lift`, {
      userId,
      reason: 'qa e2e - lifting for test',
      confirm: true,
    });
    expect(liftRes.status).toBe(200);

    await vi.waitFor(async () => {
      expect(await activeTagKeys(admin, playerId)).not.toContain('self_excluded');
    });
    await auditHasEntry(admin, playerId, 'tag.player.removed');
  });
});

describe('level: atomic replace-on-change driven by player.level.changed', () => {
  it('sets level, verifies the tag + reason, changes it again, verifies exactly one active row', async () => {
    const admin = await asAdmin(app.app);
    const email = `level-${randomUUID()}@e2e.test`;
    const { playerId } = await registerAndMaterializePlayer(app, { email: email });

    // no level tag before any admin edit
    expect(await activeTagKeys(admin, playerId)).not.toContain('level');

    const setRes = await admin.patch(`/players/${playerId}`, { level: 5 });
    expect(setRes.status).toBe(200);

    await vi.waitFor(async () => {
      const tags = await activeTags(admin, playerId);
      const levelTags = tags.filter((t) => t.key === 'level');
      expect(levelTags).toHaveLength(1);
      expect(levelTags[0]?.reason).toBe('player level set to 5');
    });

    const changeRes = await admin.patch(`/players/${playerId}`, { level: 7 });
    expect(changeRes.status).toBe(200);

    await vi.waitFor(async () => {
      const tags = await activeTags(admin, playerId);
      const levelTags = tags.filter((t) => t.key === 'level');
      expect(levelTags).toHaveLength(1);
      expect(levelTags[0]?.reason).toBe('player level set to 7');
    });

    // player.level.changed's audit resourceId is the PAM playerId (resolved from the
    // subject's identity userId), not the raw userId - see audit/plugin.ts
    // mapEventToRecord / AuditService.resolvePlayerId.
    await auditHasEntry(admin, playerId, 'player.level.changed');
  });

  it('no-op: updating a field other than level does not touch the level tag', async () => {
    const admin = await asAdmin(app.app);
    const email = `level-noop-${randomUUID()}@e2e.test`;
    const { playerId } = await registerAndMaterializePlayer(app, { email: email });

    const setRes = await admin.patch(`/players/${playerId}`, { level: 3 });
    expect(setRes.status).toBe(200);
    await vi.waitFor(async () => {
      expect(await activeTagKeys(admin, playerId)).toContain('level');
    });
    const beforeTags = await activeTags(admin, playerId);
    const beforeLevelTag = beforeTags.find((t) => t.key === 'level');

    const renameRes = await admin.patch(`/players/${playerId}`, { displayName: 'Renamed Player' });
    expect(renameRes.status).toBe(200);

    // Give the (nonexistent, for this case) async handler a beat, then assert the
    // level tag row is untouched - same reason text, still exactly one active row.
    await new Promise((r) => setTimeout(r, 300));
    const afterTags = await activeTags(admin, playerId);
    const afterLevelTags = afterTags.filter((t) => t.key === 'level');
    expect(afterLevelTags).toHaveLength(1);
    expect(afterLevelTags[0]?.reason).toBe(beforeLevelTag?.reason);
  });
});

describe('multi_account and bonus_abuser: automatic shared-IP risk tags', () => {
  it('auto-assigns both tags to both player accounts after a shared login IP', async () => {
    const admin = await asAdmin(app.app);
    const sharedIp = '203.0.113.77';
    const firstEmail = `multiacct-a-${randomUUID()}@e2e.test`;
    const secondEmail = `multiacct-b-${randomUUID()}@e2e.test`;
    const first = await registerAndMaterializePlayer(app, { email: firstEmail });
    const second = await registerAndMaterializePlayer(app, { email: secondEmail });

    await loginWithIp(app.app, firstEmail, sharedIp);
    await loginWithIp(app.app, secondEmail, sharedIp);

    await vi.waitFor(async () => {
      const firstTags = await activeTags(admin, first.playerId);
      const secondTags = await activeTags(admin, second.playerId);
      const firstKeys = firstTags.map((t) => t.key);
      const secondKeys = secondTags.map((t) => t.key);

      expect(firstKeys).toEqual(expect.arrayContaining(['multi_account', 'bonus_abuser']));
      expect(secondKeys).toEqual(expect.arrayContaining(['multi_account', 'bonus_abuser']));
      for (const tag of [...firstTags, ...secondTags].filter((t) =>
        ['multi_account', 'bonus_abuser'].includes(t.key),
      )) {
        expect(tag.reason ?? '').not.toContain(sharedIp);
      }
    });

    await auditHasEntry(admin, first.playerId, 'tag.player.assigned');
    await auditHasEntry(admin, second.playerId, 'tag.player.assigned');
  });

  it('manual removal still clears the sticky multi_account tag after review', async () => {
    const admin = await asAdmin(app.app);
    const email = `multiacct-${randomUUID()}@e2e.test`;
    const { playerId } = await registerAndMaterializePlayer(app, { email: email });

    const assignRes = await admin.post(`/player/${playerId}/player-tag`, {
      tagKey: 'multi_account',
      assignReason: 'qa e2e - suspected linked accounts',
      assignActor: 'manual',
    });
    expect(assignRes.status).toBe(200);
    expect(await activeTagKeys(admin, playerId)).toContain('multi_account');
    await auditHasEntry(admin, playerId, 'tag.player.assigned');

    const removeRes = await admin.request(`/player/${playerId}/player-tag/multi_account`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        removalReason: 'qa e2e - cleared after review',
        removalActor: 'manual',
      }),
    });
    expect(removeRes.status).toBe(200);
    expect(await activeTagKeys(admin, playerId)).not.toContain('multi_account');
    await auditHasEntry(admin, playerId, 'tag.player.removed');
  });

  it('assigning multi_account twice returns 409 CONFLICT (TagAlreadyInUseError)', async () => {
    const admin = await asAdmin(app.app);
    const email = `multiacct-conflict-${randomUUID()}@e2e.test`;
    const { playerId } = await registerAndMaterializePlayer(app, { email: email });

    const first = await admin.post(`/player/${playerId}/player-tag`, {
      tagKey: 'multi_account',
      assignReason: 'qa e2e - first assign',
      assignActor: 'manual',
    });
    expect(first.status).toBe(200);

    const second = await admin.post(`/player/${playerId}/player-tag`, {
      tagKey: 'multi_account',
      assignReason: 'qa e2e - duplicate assign',
      assignActor: 'manual',
    });
    expect(second.status).toBe(409);
  });
});

describe('bonus_abuser: generic assign/remove round-trip, no restriction blocks it', () => {
  it('assigns then removes cleanly via the generic admin routes', async () => {
    const admin = await asAdmin(app.app);
    const email = `bonusabuser-${randomUUID()}@e2e.test`;
    const { playerId } = await registerAndMaterializePlayer(app, { email: email });

    const assignRes = await admin.post(`/player/${playerId}/player-tag`, {
      tagKey: 'bonus_abuser',
      assignReason: 'qa e2e - flagged for bonus abuse pattern',
      assignActor: 'manual',
    });
    expect(assignRes.status).toBe(200);
    expect(await activeTagKeys(admin, playerId)).toContain('bonus_abuser');

    const removeRes = await admin.request(`/player/${playerId}/player-tag/bonus_abuser`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removalReason: 'qa e2e - cleared', removalActor: 'manual' }),
    });
    expect(removeRes.status).toBe(200);
    expect(await activeTagKeys(admin, playerId)).not.toContain('bonus_abuser');
  });
});

describe('authz negatives: never a success or a 500 without admin credentials', () => {
  it('rejects unauthenticated callers with 401 on tag routes and the player update route', async () => {
    const anon = app.app;
    const playerId = randomUUID();

    const listRes = await anon.request(`/player/${playerId}/player-tag?page=1&limit=20`);
    expect(listRes.status).toBe(401);

    const assignRes = await anon.request(`/player/${playerId}/player-tag`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        tagKey: 'multi_account',
        assignReason: 'anon attempt',
        assignActor: 'manual',
      }),
    });
    expect(assignRes.status).toBe(401);

    const removeRes = await anon.request(`/player/${playerId}/player-tag/multi_account`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removalReason: 'anon attempt', removalActor: 'manual' }),
    });
    expect(removeRes.status).toBe(401);

    const updateRes = await anon.request(`/players/${playerId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ level: 9 }),
    });
    expect(updateRes.status).toBe(401);
  });

  it('rejects an authenticated non-admin player with 403 on tag routes and the player update route', async () => {
    const email = `authz-bf317-${randomUUID()}@e2e.test`;
    const { client, playerId } = await registerAndMaterializePlayer(app, { email: email });

    const listRes = await client.get(`/player/${playerId}/player-tag?page=1&limit=20`);
    expect(listRes.status).toBe(403);

    const assignRes = await client.post(`/player/${playerId}/player-tag`, {
      tagKey: 'multi_account',
      assignReason: 'self attempt',
      assignActor: 'manual',
    });
    expect(assignRes.status).toBe(403);

    const removeRes = await client.request(`/player/${playerId}/player-tag/multi_account`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ removalReason: 'self attempt', removalActor: 'manual' }),
    });
    expect(removeRes.status).toBe(403);

    const updateRes = await client.patch(`/players/${playerId}`, { level: 9 });
    expect(updateRes.status).toBe(403);
  });
});

describe('seed idempotency: multi_account and level tag rows', () => {
  it('running seedTag twice produces no duplicate tag rows and no errors', async () => {
    const { seedTag } = await import('@openora/core/pam/tag/seed');
    const { tag } = await import('@openora/core/pam/schema/tag');
    const drizzle = app.container.get(DRIZZLE);

    await expect(seedTag(drizzle.db)).resolves.not.toThrow();
    await expect(seedTag(drizzle.db)).resolves.not.toThrow();

    const rows = await drizzle.db.select({ key: tag.key }).from(tag);
    const keys = rows.map((r) => r.key);
    const multiAccountCount = keys.filter((k) => k === 'multi_account').length;
    const levelCount = keys.filter((k) => k === 'level').length;
    const dormantHighRollerCount = keys.filter((k) => k === 'dormant_high_roller').length;
    expect(multiAccountCount).toBe(1);
    expect(levelCount).toBe(1);
    expect(dormantHighRollerCount).toBe(1);
  });
});

void SYSTEM_ACTOR; // documented convention referenced in comments above; not asserted directly
