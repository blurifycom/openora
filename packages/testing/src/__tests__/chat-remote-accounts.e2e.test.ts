import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { chatRoomInvite, chatRoomMember } from '@openora/core/engagement/schema/chat';
import { ChatRoomMemberSchema, type ChatRoom } from '@openora/core/engagement/contracts/chat';
import { bootE2e, closeE2e, type Chatter, type TestApp, type TestDb } from '../index.js';
import { chatInviteHelpers } from '../chat-invite-helpers.js';

// Chat reads accounts over the signed internal API here, as it does on a database of its own.
// The identity service is this same app: a call to its origin is served by `app.app.request`.
const IDENTITY_SERVICE_URL = 'http://identity.internal';
const ENV = {
  IDENTITY_SERVICE_URL,
  INTERNAL_API_SECRETS: randomBytes(32).toString('hex'),
};

let db: TestDb;
let app: TestApp;
let identityDown = false;
const identityCalls: string[] = [];
const savedEnv = Object.fromEntries(Object.keys(ENV).map((key) => [key, process.env[key]]));
const realFetch = globalThis.fetch;

const { registerChatter, createRoom, invite } = chatInviteHelpers(
  () => app,
  () => {
    throw new Error('no admin in this suite');
  },
);

async function rosterOf(viewer: Chatter, room: ChatRoom) {
  const res = await viewer.client.get(`/chat/rooms/${room.id}/members`);
  expect(res.status).toBe(200);
  return ChatRoomMemberSchema.array().parse(await res.json());
}

async function invitesTo(userId: string) {
  return app.container
    .get(DRIZZLE)
    .db.select({ id: chatRoomInvite.id, withheld: chatRoomInvite.withheld })
    .from(chatRoomInvite)
    .where(eq(chatRoomInvite.inviteeId, userId));
}

beforeAll(async () => {
  Object.assign(process.env, ENV);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(IDENTITY_SERVICE_URL)) {
      return realFetch(input, init);
    }
    identityCalls.push(new URL(url).pathname);
    if (identityDown) {
      throw new TypeError('fetch failed');
    }
    return app.app.request(url, init);
  });
  ({ db, app } = await bootE2e());
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  await closeE2e({ app, db });
});

describe('chat reading accounts from the identity service', () => {
  it('reads accounts over the internal API', async () => {
    const owner = await registerChatter('remote');
    identityCalls.length = 0;

    await createRoom(owner);

    expect(identityCalls).toContain('/internal/v1/identity/accounts');
  });

  it('lists a member the identity service does not know as "Unknown player"', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const ghostId = randomUUID();
    await app.container
      .get(DRIZZLE)
      .db.insert(chatRoomMember)
      .values({ roomId: room.id, userId: ghostId });

    expect(await rosterOf(owner, room)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.userId, username: owner.username }),
        expect.objectContaining({ userId: ghostId, username: 'Unknown player' }),
      ]),
    );
  });

  it('keeps a staff member out of a player roster', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const staff = await registerChatter('crew');
    await app.container
      .get(DRIZZLE)
      .db.update(user)
      .set({ role: 'admin' })
      .where(eq(user.id, staff.userId));
    await app.container
      .get(DRIZZLE)
      .db.insert(chatRoomMember)
      .values({ roomId: room.id, userId: staff.userId });

    expect((await rosterOf(owner, room)).map((member) => member.userId)).toEqual([owner.userId]);
  });

  it('withholds an invite to a closed account', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    const closed = await registerChatter('closed');
    await app.container
      .get(DRIZZLE)
      .db.update(player)
      .set({ status: 'closed' })
      .where(eq(player.userId, closed.userId));

    expect((await invite(owner, room, closed.userId)).status).toBe(200);

    expect(await invitesTo(closed.userId)).toEqual([expect.objectContaining({ withheld: true })]);
    const shown = await closed.client.get('/chat/invites');
    expect(shown.status).toBe(200);
    expect(await shown.json()).toEqual([]);
  });

  it('refuses, and writes nothing, while the identity service is down', async () => {
    const owner = await registerChatter('host');
    const room = await createRoom(owner);
    // Never read by chat before, so no cached answer stands in for the identity service.
    const invitee = await registerChatter('invitee');

    identityDown = true;
    try {
      expect((await invite(owner, room, invitee.userId)).status).toBeGreaterThanOrEqual(500);
    } finally {
      identityDown = false;
    }

    expect(await invitesTo(invitee.userId)).toEqual([]);
  });
});
