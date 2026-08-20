import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import {
  loadExtensions,
  DRIZZLE,
  type Container,
  type CoreTokenCatalog,
} from '@openora/core/server';
import { player } from '@openora/core/pam/schema/profile';
import { friendship } from '@openora/core/engagement/schema/social';
import { chatUserBlock } from '@openora/core/engagement/schema/chat';
import {
  setupTestDb,
  bootTestApp,
  asPlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * Independent QA E2E walkthrough for "Send friend requests" (engagement/social)
 * driven over the REAL app (bootTestApp: real Hono + oRPC + Postgres + Redis
 * Streams event bus) rather than the implementer's own router/service-level int
 * tests (social.router.int.test.ts, social.service.int.test.ts), which build
 * the router directly with a fake in-process EventBus and never exercise the
 * real cross-module wiring: the notifications plugin's event subscription, the
 * audit plugin's event subscription, or the real (asynchronous,
 * Redis-Streams-backed) event pipeline between them. This suite verifies the
 * accepted-spec checklist end to end: relationship button-state, the
 * pending/duplicate/blocked gates, the two locked product decisions (mutual
 * auto-accept, self-block-disclosed), notification+audit side effects, and a
 * concurrent double-submit race.
 *
 * chat_user_block has no write route in this walkthrough - block rows are
 * seeded directly via Drizzle.
 * Likewise there is no explicit "accept" route: the only way to reach an
 * `accepted` friendship is the mutual/simultaneous-request auto-accept path,
 * so that describe block doubles as the fixture for the "already friends"
 * re-send test.
 */

let db: TestDb;
let app: TestApp;
let admin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function registerAndMaterializePlayer(hono: TestApp['app'], email: string, name: string) {
  const registerRes = await hono.request('/identity/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password123', name }),
  });
  if (!registerRes.ok) {
    throw new Error(`register failed (${registerRes.status}): ${await registerRes.text()}`);
  }
  const client = await asPlayer(hono, { email });
  const profileRes = await client.get('/profile');
  if (!profileRes.ok) {
    throw new Error(
      `profile materialize failed (${profileRes.status}): ${await profileRes.text()}`,
    );
  }
  const profile = (await profileRes.json()) as { id: string; userId: string };
  return { client, playerId: profile.id, userId: profile.userId };
}

async function setPlayerStatus(
  container: Container<CoreTokenCatalog>,
  userId: string,
  status: 'suspended' | 'closed' | 'active',
) {
  await container.get(DRIZZLE).db.update(player).set({ status }).where(eq(player.userId, userId));
}

async function insertBlock(
  container: Container<CoreTokenCatalog>,
  blockerId: string,
  blockedId: string,
) {
  await container.get(DRIZZLE).db.insert(chatUserBlock).values({ blockerId, blockedId });
}

async function friendshipRowCount(
  container: Container<CoreTokenCatalog>,
  userA: string,
  userB: string,
): Promise<number> {
  const all = await container.get(DRIZZLE).db.select().from(friendship);
  return all.filter(
    (r) =>
      (r.requesterId === userA && r.addresseeId === userB) ||
      (r.requesterId === userB && r.addresseeId === userA),
  ).length;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();
  app = await bootTestApp({ plugins: basePlugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('AC: relationship button-state + pending-on-send', () => {
  it('none -> send -> pending_outgoing (sender) / pending_incoming (recipient), immediately, no polling', async () => {
    const a = await registerAndMaterializePlayer(app.app, `a-${randomUUID()}@e2e.test`, 'Alice');
    const b = await registerAndMaterializePlayer(app.app, `b-${randomUUID()}@e2e.test`, 'Bob');

    const beforeRes = await a.client.post('/social/relationships', { userIds: [b.userId] });
    expect(beforeRes.status).toBe(200);
    expect(await readJson(beforeRes)).toEqual([
      { userId: b.userId, status: 'none', friendshipId: null, canSendRequest: true },
    ]);

    const sendRes = await a.client.post('/social/friend-requests', { targetUserId: b.userId });
    expect(sendRes.status).toBe(200);
    const sent = await readJson(sendRes);
    expect(sent).toMatchObject({
      requesterId: a.userId,
      addresseeId: b.userId,
      acceptedAt: null,
      refusedAt: null,
    });

    // AC: "changes the option to Pending on the sender's side immediately" - no
    // waitFor, this must be true on the very next request.
    const aView = await readJson(
      await a.client.post('/social/relationships', { userIds: [b.userId] }),
    );
    expect(aView).toEqual([
      {
        userId: b.userId,
        status: 'pending_outgoing',
        friendshipId: sent.id,
        canSendRequest: false,
      },
    ]);

    const bView = await readJson(
      await b.client.post('/social/relationships', { userIds: [a.userId] }),
    );
    expect(bView).toEqual([
      {
        userId: a.userId,
        status: 'pending_incoming',
        friendshipId: sent.id,
        canSendRequest: false,
      },
    ]);
  });
});

describe('AC: recipient gets an in-app notification, type round-trips, and audit trail exists', () => {
  it('notifications.list surfaces social.friend_request.received with the right title/body; audit log exists', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `notif-a-${randomUUID()}@e2e.test`,
      'Carol',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `notif-b-${randomUUID()}@e2e.test`,
      'Dave',
    );

    const sent = await readJson(
      await a.client.post('/social/friend-requests', { targetUserId: b.userId }),
    );

    // Redis-Streams-backed EventBus is fire-and-forget/async (bootTestApp binds the
    // real RedisStreamsBroker) - the notification/audit consumer loops land after
    // the HTTP response, not within it. Poll rather than assert synchronously.
    await vi.waitFor(async () => {
      const listRes = await b.client.get('/notifications');
      expect(listRes.status).toBe(200);
      const items = (await readJson(listRes)) as Array<{
        type: string;
        title: string;
        body: string;
      }>;
      const row = items.find((n) => n.type === 'social.friend_request.received');
      // This is the exact silent-drop failure mode the brief calls out: a
      // notification whose `type` is missing from NOTIFICATION_TYPES is written
      // to the DB but filtered out (flatMap + safeParse) before it ever reaches
      // this response - so finding it HERE (not just in the DB) is the real
      // assertion that the type round-trips end to end.
      expect(row).toBeTruthy();
      expect(row?.title).toBe('New friend request');
      expect(row?.body).toContain('Carol');
    });

    await vi.waitFor(async () => {
      const auditRes = await admin.get(
        `/audit/logs?resourceId=${sent.id}&action=social.friend_request.sent`,
      );
      expect(auditRes.status).toBe(200);
      const auditBody = await readJson(auditRes);
      expect(auditBody.items.length).toBeGreaterThanOrEqual(1);
      expect(auditBody.items[0]).toMatchObject({
        actorType: 'player',
        actorId: a.userId,
        resourceType: 'friendship',
      });
      expect(auditBody.items[0].after).toMatchObject({ addresseeId: b.userId, status: 'pending' });
    });
  });
});

describe('AC: duplicate request while pending is rejected, not silently accepted or double-inserted', () => {
  it('a second sendFriendRequest to the same still-pending target fails with CONFLICT and leaves exactly one row', async () => {
    const a = await registerAndMaterializePlayer(app.app, `dup-a-${randomUUID()}@e2e.test`, 'Eve');
    const b = await registerAndMaterializePlayer(
      app.app,
      `dup-b-${randomUUID()}@e2e.test`,
      'Frank',
    );

    const first = await readJson(
      await a.client.post('/social/friend-requests', { targetUserId: b.userId }),
    );
    expect(first.acceptedAt).toBeNull();
    expect(first.refusedAt).toBeNull();

    const secondRes = await a.client.post('/social/friend-requests', { targetUserId: b.userId });
    expect(secondRes.status).toBe(409);

    expect(await friendshipRowCount(app.container, a.userId, b.userId)).toBe(1);

    // Relationship state is unchanged - still pointing at the original row.
    const aView = await readJson(
      await a.client.post('/social/relationships', { userIds: [b.userId] }),
    );
    expect(aView[0]).toMatchObject({ status: 'pending_outgoing', friendshipId: first.id });
  });
});

describe('AC: "Add Friend" not offered when the recipient has blocked the sender (undisclosed)', () => {
  it('sendFriendRequest maps to CONFLICT (identical shape to a suspended target, distinct from a nonexistent one) and getRelationships returns unavailable', async () => {
    const target = await registerAndMaterializePlayer(
      app.app,
      `blk-target-${randomUUID()}@e2e.test`,
      'Grace',
    );
    const blockedSender = await registerAndMaterializePlayer(
      app.app,
      `blk-sender-${randomUUID()}@e2e.test`,
      'Heidi',
    );
    await insertBlock(app.container, target.userId, blockedSender.userId); // target blocks sender

    const sendRes = await blockedSender.client.post('/social/friend-requests', {
      targetUserId: target.userId,
    });
    // Not a 404: the target genuinely exists, so the API doesn't lie about that -
    // it only withholds WHY the request can't go through (see FriendRequestUnavailableError).
    expect(sendRes.status).toBe(409);
    const sendBody = await readJson(sendRes);
    expect(String(sendBody.message).toLowerCase()).not.toContain('block');

    // A genuinely nonexistent target is a real, distinct 404 - the API no longer
    // conflates "blocked me" with "doesn't exist".
    const nonexistentRes = await blockedSender.client.post('/social/friend-requests', {
      targetUserId: randomUUID(),
    });
    expect(nonexistentRes.status).toBe(404);

    // But a suspended target gets the SAME 409 shape as a block: the caller still
    // cannot distinguish "blocked me" from "moderated" from the response.
    const suspendedTarget = await registerAndMaterializePlayer(
      app.app,
      `blk-mod-${randomUUID()}@e2e.test`,
      'Grace Moderated',
    );
    await setPlayerStatus(app.container, suspendedTarget.userId, 'suspended');
    const suspendedRes = await blockedSender.client.post('/social/friend-requests', {
      targetUserId: suspendedTarget.userId,
    });
    expect(suspendedRes.status).toBe(409);
    const suspendedBody = await readJson(suspendedRes);
    expect(sendBody.message).toBe(suspendedBody.message);

    const relRes = await blockedSender.client.post('/social/relationships', {
      userIds: [target.userId],
    });
    expect(await readJson(relRes)).toEqual([
      { userId: target.userId, status: 'unavailable', friendshipId: null, canSendRequest: false },
    ]);
  });
});

describe('locked decision: caller blocked the target themselves -> disclosed CONFLICT (BLOCKED_BY_SELF)', () => {
  it('is a distinct, disclosed conflict - not the generic not-found used for the reverse-block case', async () => {
    const blocker = await registerAndMaterializePlayer(
      app.app,
      `selfblk-${randomUUID()}@e2e.test`,
      'Ivan',
    );
    const target = await registerAndMaterializePlayer(
      app.app,
      `selfblk-target-${randomUUID()}@e2e.test`,
      'Judy',
    );
    await insertBlock(app.container, blocker.userId, target.userId); // caller blocks target

    const res = await blocker.client.post('/social/friend-requests', {
      targetUserId: target.userId,
    });
    expect(res.status).toBe(409);
    const body = await readJson(res);
    expect(String(body.message).toLowerCase()).toContain('block');
  });
});

describe('locked decision: self-request is rejected', () => {
  it('targetUserId === callerId -> BAD_REQUEST', async () => {
    const a = await registerAndMaterializePlayer(app.app, `self-${randomUUID()}@e2e.test`, 'Kim');
    const res = await a.client.post('/social/friend-requests', { targetUserId: a.userId });
    expect(res.status).toBe(400);
  });
});

describe('locked decision: mutual/simultaneous request auto-accepts', () => {
  it('B sending back to A while A->B is pending flips the SAME row to accepted, notifies the original requester, and a later re-send is ALREADY_FRIENDS', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `mutual-a-${randomUUID()}@e2e.test`,
      'Leo',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `mutual-b-${randomUUID()}@e2e.test`,
      'Mona',
    );

    // A -> B (pending)
    const first = await readJson(
      await a.client.post('/social/friend-requests', { targetUserId: b.userId }),
    );
    expect(first.acceptedAt).toBeNull();
    expect(first.refusedAt).toBeNull();

    // B -> A (reverse direction) must resolve the EXISTING row, not create a new one.
    const second = await readJson(
      await b.client.post('/social/friend-requests', { targetUserId: a.userId }),
    );
    expect(second.id).toBe(first.id);
    expect(second.acceptedAt).toEqual(expect.any(String));
    expect(second.refusedAt).toBeNull();

    expect(await friendshipRowCount(app.container, a.userId, b.userId)).toBe(1);

    const aView = await readJson(
      await a.client.post('/social/relationships', { userIds: [b.userId] }),
    );
    expect(aView[0]).toMatchObject({ status: 'friends', friendshipId: first.id });
    const bView = await readJson(
      await b.client.post('/social/relationships', { userIds: [a.userId] }),
    );
    expect(bView[0]).toMatchObject({ status: 'friends', friendshipId: first.id });

    // A was the ORIGINAL requester - A gets the accepted notification, not B.
    await vi.waitFor(async () => {
      const items = (await readJson(await a.client.get('/notifications'))) as Array<{
        type: string;
        body: string;
      }>;
      const row = items.find((n) => n.type === 'social.friend_request.accepted');
      expect(row).toBeTruthy();
      expect(row?.body).toContain('Mona');
    });

    // Already-accepted friendship -> re-send fails ALREADY_FRIENDS, in either direction.
    const reSendRes = await a.client.post('/social/friend-requests', { targetUserId: b.userId });
    expect(reSendRes.status).toBe(409);
    const reSendBody = await readJson(reSendRes);
    expect(String(reSendBody.message).toLowerCase()).toContain('already friends');

    const reSendReverseRes = await b.client.post('/social/friend-requests', {
      targetUserId: a.userId,
    });
    expect(reSendReverseRes.status).toBe(409);
  });
});

describe('locked decision: a suspended/closed target is unavailable, not a false 404', () => {
  it('suspended and closed targets both CONFLICT on send and are unavailable in getRelationships, moderation status never disclosed', async () => {
    const caller = await registerAndMaterializePlayer(
      app.app,
      `mod-caller-${randomUUID()}@e2e.test`,
      'Nina',
    );

    for (const status of ['suspended', 'closed'] as const) {
      const target = await registerAndMaterializePlayer(
        app.app,
        `mod-${status}-${randomUUID()}@e2e.test`,
        `Target ${status}`,
      );
      await setPlayerStatus(app.container, target.userId, status);

      const sendRes = await caller.client.post('/social/friend-requests', {
        targetUserId: target.userId,
      });
      // The target genuinely exists - a real 404 would be a lie a downstream API
      // consumer could act on incorrectly (e.g. "no such player").
      expect(sendRes.status).toBe(409);
      const body = await readJson(sendRes);
      expect(String(body.message).toLowerCase()).not.toContain(status);

      const relRes = await caller.client.post('/social/relationships', {
        userIds: [target.userId],
      });
      expect(await readJson(relRes)).toEqual([
        { userId: target.userId, status: 'unavailable', friendshipId: null, canSendRequest: false },
      ]);
    }
  });
});

describe('break-it: rapid concurrent double-submit at the same target', () => {
  it('fires two sendFriendRequest calls at once - exactly one row, exactly one notification, no 500', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `race-a-${randomUUID()}@e2e.test`,
      'Oscar',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `race-b-${randomUUID()}@e2e.test`,
      'Peggy',
    );

    const [r1, r2] = await Promise.all([
      a.client.post('/social/friend-requests', { targetUserId: b.userId }),
      a.client.post('/social/friend-requests', { targetUserId: b.userId }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    // Exactly one winner (200) and one loser (409, RequestAlreadyPendingError) -
    // never two winners (double-insert) and never an unhandled 500.
    expect(statuses).toEqual([200, 409]);

    expect(await friendshipRowCount(app.container, a.userId, b.userId)).toBe(1);

    await vi.waitFor(async () => {
      const items = (await readJson(await b.client.get('/notifications'))) as Array<{
        type: string;
      }>;
      const matches = items.filter((n) => n.type === 'social.friend_request.received');
      expect(matches.length).toBe(1);
    });
  });
});

describe('authz: unauthenticated caller', () => {
  it('sendFriendRequest and getRelationships both 401 with no session', async () => {
    const sendRes = await app.app.request('/social/friend-requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targetUserId: randomUUID() }),
    });
    expect(sendRes.status).toBe(401);

    const relRes = await app.app.request('/social/relationships', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userIds: [randomUUID()] }),
    });
    expect(relRes.status).toBe(401);
  });
});
