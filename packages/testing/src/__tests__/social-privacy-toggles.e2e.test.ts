import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { player } from '@openora/core/pam/schema/profile';
import { friendship } from '@openora/core/engagement/schema/social';
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
 * The two community toggles the platform owns on `player`: `allowFriendRequests` refuses a
 * new friend request with a distinct, disclosed conflict, and `showOnlineStatusToFriends`
 * blanks both `status` and `lastSeenAt` in the friend list. Both are written through
 * `PATCH /profile`, which records an audit row in the same transaction.
 */

let db: TestDb;
let app: TestApp;
let admin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function newPlayer(label: string) {
  const email = `privacy-${label}-${randomUUID()}@e2e.test`;
  return registerAndMaterializePlayer(app, { email });
}

async function befriend(
  a: { client: TestClient; userId: string },
  b: { client: TestClient; userId: string },
) {
  expect((await a.client.post('/social/friend-requests', { targetUserId: b.userId })).status).toBe(
    200,
  );
  expect((await b.client.post('/social/friend-requests', { targetUserId: a.userId })).status).toBe(
    200,
  );
}

async function friendshipRowCount(userA: string, userB: string): Promise<number> {
  const all = await app.container.get(DRIZZLE).db.select().from(friendship);
  return all.filter(
    (r) =>
      (r.requesterId === userA && r.addresseeId === userB) ||
      (r.requesterId === userB && r.addresseeId === userA),
  ).length;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  app = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('PATCH /profile - community toggles', () => {
  it('defaults both toggles on, persists a change, and audits it in the same write', async () => {
    const { client } = await newPlayer('persist');

    const before = await readJson(await client.get('/profile'));
    expect(before).toMatchObject({ allowFriendRequests: true, showOnlineStatusToFriends: true });

    const res = await client.patch('/profile', {
      allowFriendRequests: false,
      showOnlineStatusToFriends: false,
    });
    expect(res.status).toBe(200);
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      allowFriendRequests: false,
      showOnlineStatusToFriends: false,
    });

    // Written inside the profile transaction, not by an async consumer - no polling needed.
    const auditRes = await admin.get(
      `/audit/logs?resourceId=${before.id}&action=player.profile.updated`,
    );
    expect(auditRes.status).toBe(200);
    const { items } = await readJson(auditRes);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      actorType: 'player',
      resourceType: 'player',
      before: { allowFriendRequests: true, showOnlineStatusToFriends: true },
      after: { allowFriendRequests: false, showOnlineStatusToFriends: false },
    });
  });

  it('rejects a non-boolean toggle and writes nothing', async () => {
    const { client } = await newPlayer('invalid');

    const res = await client.patch('/profile', { allowFriendRequests: 'no' });

    expect(res.status).toBe(400);
    expect(await readJson(await client.get('/profile'))).toMatchObject({
      allowFriendRequests: true,
    });
  });

  it('rejects an unauthenticated write', async () => {
    const res = await app.app.request('/profile', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowFriendRequests: false }),
    });
    expect(res.status).toBe(401);
  });
});

describe('allowFriendRequests', () => {
  it('refuses a new request with a distinct FRIEND_REQUESTS_DISABLED conflict and no row', async () => {
    const sender = await newPlayer('sender');
    const target = await newPlayer('closed-target');
    await target.client.patch('/profile', { allowFriendRequests: false });

    const relRes = await sender.client.post('/social/relationships', {
      userIds: [target.userId],
    });
    expect(await readJson(relRes)).toEqual([
      { userId: target.userId, status: 'none', friendshipId: null, canSendRequest: false },
    ]);

    const sendRes = await sender.client.post('/social/friend-requests', {
      targetUserId: target.userId,
    });
    expect(sendRes.status).toBe(409);
    expect((await readJson(sendRes)).data).toEqual({ code: 'FRIEND_REQUESTS_DISABLED' });
    expect(await friendshipRowCount(sender.userId, target.userId)).toBe(0);
  });

  it("still lets the caller answer the target's own pending request", async () => {
    const caller = await newPlayer('answerer');
    const target = await newPlayer('asker');
    const sent = await readJson(
      await target.client.post('/social/friend-requests', { targetUserId: caller.userId }),
    );
    await target.client.patch('/profile', { allowFriendRequests: false });

    const res = await caller.client.post('/social/friend-requests', {
      targetUserId: target.userId,
    });

    expect(res.status).toBe(200);
    const accepted = await readJson(res);
    expect(accepted.id).toBe(sent.id);
    expect(accepted.acceptedAt).toEqual(expect.any(String));
  });

  it('turning it back on accepts requests again', async () => {
    const sender = await newPlayer('retry-sender');
    const target = await newPlayer('retry-target');
    await target.client.patch('/profile', { allowFriendRequests: false });
    await target.client.patch('/profile', { allowFriendRequests: true });

    const res = await sender.client.post('/social/friend-requests', {
      targetUserId: target.userId,
    });

    expect(res.status).toBe(200);
  });
});

describe('showOnlineStatusToFriends', () => {
  it('shows an online friend by default and blanks status and lastSeenAt once hidden', async () => {
    const viewer = await newPlayer('viewer');
    const friend = await newPlayer('friend');
    await befriend(viewer, friend);
    await app.container
      .get(DRIZZLE)
      .db.update(player)
      .set({ lastSeenAt: new Date() })
      .where(eq(player.userId, friend.userId));

    const shown = await readJson(await viewer.client.get('/social/friends?page=1&limit=20'));
    expect(shown.items).toEqual([
      expect.objectContaining({
        userId: friend.userId,
        status: 'online',
        lastSeenAt: expect.any(String),
      }),
    ]);

    await friend.client.patch('/profile', { showOnlineStatusToFriends: false });

    await vi.waitFor(async () => {
      const hidden = await readJson(await viewer.client.get('/social/friends?page=1&limit=20'));
      expect(hidden.items).toEqual([
        expect.objectContaining({ userId: friend.userId, status: null, lastSeenAt: null }),
      ]);
    });
  });
});
