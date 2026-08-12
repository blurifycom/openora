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
import { friendship, socialUserBlock } from '@openora/core/engagement/schema/social';
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
 * Independent QA E2E walkthrough for BF-425 ("Send friend requests" -
 * engagement/social) driven over the REAL app (bootTestApp: real Hono + oRPC +
 * Postgres + Redis Streams event bus) rather than the implementer's own
 * router/service-level int tests (social.router.int.test.ts,
 * social.service.int.test.ts), which build the router directly with a fake
 * in-process EventBus and never exercise the real cross-module wiring: the
 * notifications plugin's event subscription, the audit plugin's event
 * subscription, or the real (asynchronous, Redis-Streams-backed) event
 * pipeline between them. This suite verifies the accepted-spec checklist from
 * BF-425 end to end: relationship button-state, the pending/duplicate/blocked
 * gates, the two locked product decisions (mutual auto-accept,
 * self-block-disclosed), notification+audit side effects, and a concurrent
 * double-submit race.
 *
 * social_user_block has no write route yet (schema-only this PR, per the
 * schema file's own comment) - block rows are seeded directly via Drizzle.
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
  await container.get(DRIZZLE).db.insert(socialUserBlock).values({ blockerId, blockedId });
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

describe('BF-425 AC: relationship button-state + pending-on-send', () => {
  it('none -> send -> pending_outgoing (sender) / pending_incoming (recipient), immediately, no polling', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `bf425-a-${randomUUID()}@e2e.test`,
      'Alice BF425',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `bf425-b-${randomUUID()}@e2e.test`,
      'Bob BF425',
    );

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
      status: 'pending',
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

describe('BF-425 AC: recipient gets an in-app notification, type round-trips, and audit trail exists', () => {
  it('notifications.list surfaces social.friend_request.received with the right title/body; audit log exists', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `bf425-notif-a-${randomUUID()}@e2e.test`,
      'Carol BF425',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `bf425-notif-b-${randomUUID()}@e2e.test`,
      'Dave BF425',
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
      expect(row?.body).toContain('Carol BF425');
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

describe('BF-425 AC: duplicate request while pending is rejected, not silently accepted or double-inserted', () => {
  it('a second sendFriendRequest to the same still-pending target fails with CONFLICT and leaves exactly one row', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `bf425-dup-a-${randomUUID()}@e2e.test`,
      'Eve BF425',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `bf425-dup-b-${randomUUID()}@e2e.test`,
      'Frank BF425',
    );

    const first = await readJson(
      await a.client.post('/social/friend-requests', { targetUserId: b.userId }),
    );
    expect(first.status).toBe('pending');

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

describe('BF-425 AC: "Add Friend" not offered when the recipient has blocked the sender (undisclosed)', () => {
  it('sendFriendRequest maps to NOT_FOUND (identical shape to a nonexistent target) and getRelationships returns unavailable', async () => {
    const target = await registerAndMaterializePlayer(
      app.app,
      `bf425-blk-target-${randomUUID()}@e2e.test`,
      'Grace BF425',
    );
    const blockedSender = await registerAndMaterializePlayer(
      app.app,
      `bf425-blk-sender-${randomUUID()}@e2e.test`,
      'Heidi BF425',
    );
    await insertBlock(app.container, target.userId, blockedSender.userId); // target blocks sender

    const sendRes = await blockedSender.client.post('/social/friend-requests', {
      targetUserId: target.userId,
    });
    expect(sendRes.status).toBe(404);
    const sendBody = await readJson(sendRes);
    expect(String(sendBody.message).toLowerCase()).not.toContain('block');

    // Compare against a genuinely nonexistent target: the caller must not be able
    // to distinguish "blocked me" from "doesn't exist" from the response shape.
    const randomTargetId = randomUUID();
    const nonexistentRes = await blockedSender.client.post('/social/friend-requests', {
      targetUserId: randomTargetId,
    });
    expect(nonexistentRes.status).toBe(404);
    const nonexistentBody = await readJson(nonexistentRes);
    // Same error class -> same message template ("FriendRequestTarget not found:
    // <id>"), with only the target id (something the caller already supplied,
    // so it discloses nothing new) differing between the two responses.
    expect(sendBody.message.replace(target.userId, '<ID>')).toBe(
      nonexistentBody.message.replace(randomTargetId, '<ID>'),
    );

    const relRes = await blockedSender.client.post('/social/relationships', {
      userIds: [target.userId],
    });
    expect(await readJson(relRes)).toEqual([
      { userId: target.userId, status: 'unavailable', friendshipId: null, canSendRequest: false },
    ]);
  });
});

describe('BF-425 locked decision: caller blocked the target themselves -> disclosed CONFLICT (BLOCKED_BY_SELF)', () => {
  it('is a distinct, disclosed conflict - not the generic not-found used for the reverse-block case', async () => {
    const blocker = await registerAndMaterializePlayer(
      app.app,
      `bf425-selfblk-${randomUUID()}@e2e.test`,
      'Ivan BF425',
    );
    const target = await registerAndMaterializePlayer(
      app.app,
      `bf425-selfblk-target-${randomUUID()}@e2e.test`,
      'Judy BF425',
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

describe('BF-425 locked decision: self-request is rejected', () => {
  it('targetUserId === callerId -> BAD_REQUEST', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `bf425-self-${randomUUID()}@e2e.test`,
      'Kim BF425',
    );
    const res = await a.client.post('/social/friend-requests', { targetUserId: a.userId });
    expect(res.status).toBe(400);
  });
});

describe('BF-425 locked decision: mutual/simultaneous request auto-accepts', () => {
  it('B sending back to A while A->B is pending flips the SAME row to accepted, notifies the original requester, and a later re-send is ALREADY_FRIENDS', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `bf425-mutual-a-${randomUUID()}@e2e.test`,
      'Leo BF425',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `bf425-mutual-b-${randomUUID()}@e2e.test`,
      'Mona BF425',
    );

    // A -> B (pending)
    const first = await readJson(
      await a.client.post('/social/friend-requests', { targetUserId: b.userId }),
    );
    expect(first.status).toBe('pending');

    // B -> A (reverse direction) must resolve the EXISTING row, not create a new one.
    const second = await readJson(
      await b.client.post('/social/friend-requests', { targetUserId: a.userId }),
    );
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('accepted');

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
      expect(row?.body).toContain('Mona BF425');
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

describe('BF-425 locked decision: a suspended/closed target behaves identically to a nonexistent one', () => {
  it('suspended and closed targets both 404 on send and are unavailable in getRelationships, moderation status never disclosed', async () => {
    const caller = await registerAndMaterializePlayer(
      app.app,
      `bf425-mod-caller-${randomUUID()}@e2e.test`,
      'Nina BF425',
    );

    for (const status of ['suspended', 'closed'] as const) {
      const target = await registerAndMaterializePlayer(
        app.app,
        `bf425-mod-${status}-${randomUUID()}@e2e.test`,
        `Target ${status} BF425`,
      );
      await setPlayerStatus(app.container, target.userId, status);

      const sendRes = await caller.client.post('/social/friend-requests', {
        targetUserId: target.userId,
      });
      expect(sendRes.status).toBe(404);
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

describe('BF-425 break-it: rapid concurrent double-submit at the same target', () => {
  it('fires two sendFriendRequest calls at once - exactly one row, exactly one notification, no 500', async () => {
    const a = await registerAndMaterializePlayer(
      app.app,
      `bf425-race-a-${randomUUID()}@e2e.test`,
      'Oscar BF425',
    );
    const b = await registerAndMaterializePlayer(
      app.app,
      `bf425-race-b-${randomUUID()}@e2e.test`,
      'Peggy BF425',
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

describe('BF-425 authz: unauthenticated caller', () => {
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
