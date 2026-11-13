import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { chatMessage, chatRoomInvite, chatRoomMember } from '@openora/core/engagement/schema/chat';
import {
  ChatMessageSchema,
  ChatRoomMemberSchema,
  type ChatRoom,
} from '@openora/core/engagement/contracts/chat';
import {
  bootE2e,
  bootTestApp,
  closeE2e,
  registerChatter,
  type Chatter,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import { chatInviteHelpers } from '../chat-invite-helpers.js';

// Two apps on one database: a monolith serving identity, and a chat service that reads every
// account from it over the signed internal API. A call to the identity origin is served by the
// identity app in process, or fails as `identity` says.
const IDENTITY_SERVICE_URL = 'http://identity.internal';
const CHAT_SERVICE_NAME = 'chat-e2e';
const SHARED_ENV = {
  INTERNAL_API_SECRETS: randomBytes(32).toString('hex'),
  ACCOUNT_READER_CALLERS: CHAT_SERVICE_NAME,
};
const CHAT_ENV = {
  // What the boot asks for on top of chat, social and identity:no-routes.
  SERVICE_MANIFEST: [
    'chat',
    'social',
    'identity:no-routes',
    'audit',
    'mail',
    'compliance',
    'iam',
    'player-management',
    'wallet',
    'gaming',
    'exchange-rate',
  ].join(','),
  SERVICE_NAME: CHAT_SERVICE_NAME,
  REALTIME_NAMESPACE: CHAT_SERVICE_NAME,
  IDENTITY_SERVICE_URL,
};

type IdentityMode = 'up' | 'down' | 502 | 400;

let db: TestDb;
let identityApp: TestApp;
let chatApp: TestApp;
let identity: IdentityMode = 'up';
const identityCalls: string[] = [];
const realFetch = globalThis.fetch;

const { createRoom, invite } = chatInviteHelpers(
  () => identityApp,
  () => {
    throw new Error('no admin client in this suite');
  },
);

function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

/** A client of the chat service, signed in through the identity service. */
async function chatClientFor(email: string): Promise<TestClient> {
  const login = await identityApp.app.request('/identity/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'password1234' }),
  });
  expect(login.status).toBe(200);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  const call = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set('cookie', cookie);
    return chatApp.app.request(path, { ...init, headers });
  };
  const withBody = (method: string) => (path: string, body?: unknown) =>
    call(path, {
      method,
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
  return {
    request: call,
    get: (path) => call(path, { method: 'GET' }),
    post: withBody('POST'),
    put: withBody('PUT'),
    patch: withBody('PATCH'),
    del: (path) => call(path, { method: 'DELETE' }),
  };
}

/** A player registered with identity, whose client talks to the chat service. */
async function chatter(prefix: string): Promise<Chatter> {
  const registered = await registerChatter(identityApp, prefix);
  return { ...registered, client: await chatClientFor(`${registered.username}@e2e.test`) };
}

function whileIdentity<T>(mode: IdentityMode, run: () => Promise<T>): Promise<T> {
  identity = mode;
  return run().finally(() => {
    identity = 'up';
  });
}

const sql = () => identityApp.container.get(DRIZZLE).db;

async function rosterOf(viewer: Chatter, room: ChatRoom) {
  const res = await viewer.client.get(`/chat/rooms/${room.id}/members`);
  expect(res.status).toBe(200);
  return ChatRoomMemberSchema.array().parse(await res.json());
}

async function invitesTo(userId: string) {
  return sql()
    .select({ id: chatRoomInvite.id, withheld: chatRoomInvite.withheld })
    .from(chatRoomInvite)
    .where(eq(chatRoomInvite.inviteeId, userId));
}

async function errorOf(res: Response) {
  return { status: res.status, code: ((await res.json()) as { code?: string }).code };
}

beforeAll(async () => {
  Object.assign(process.env, SHARED_ENV);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(IDENTITY_SERVICE_URL)) {
      return realFetch(input, init);
    }
    identityCalls.push(new URL(url).pathname);
    if (identity === 'down') {
      throw new TypeError('fetch failed');
    }
    if (identity !== 'up') {
      return new Response('{}', { status: identity });
    }
    return identityApp.app.request(url, init);
  });
  ({ db, app: identityApp } = await bootE2e());
  chatApp = await withEnv(CHAT_ENV, async () =>
    bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url }),
  );
}, 90_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(SHARED_ENV)) {
    delete process.env[key];
  }
  await chatApp?.close();
  await closeE2e({ app: identityApp, db });
});

describe('chat on its own service, reading accounts from the identity service', () => {
  it('refuses to boot while it also serves identity', async () => {
    const refusal = await withEnv({ IDENTITY_SERVICE_URL }, async () =>
      bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url }).then(
        async (booted) => {
          await booted.close();
          return 'booted';
        },
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      ),
    );

    expect(refusal).toMatch(/serves the identity module itself/);
  });

  it('reads accounts over the internal API', async () => {
    const owner = await chatter('remote');
    identityCalls.length = 0;

    await createRoom(owner);

    expect(identityCalls).toContain('/internal/v1/identity/accounts');
  });

  it('lists a member the identity service does not know as "Unknown player"', async () => {
    const owner = await chatter('host');
    const room = await createRoom(owner);
    const ghostId = randomUUID();
    await sql().insert(chatRoomMember).values({ roomId: room.id, userId: ghostId });

    expect(await rosterOf(owner, room)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: owner.userId, username: owner.username }),
        expect.objectContaining({ userId: ghostId, username: 'Unknown player' }),
      ]),
    );
  });

  it('keeps a staff member out of a player roster', async () => {
    const owner = await chatter('host');
    const room = await createRoom(owner);
    const staff = await chatter('crew');
    await sql().update(user).set({ role: 'admin' }).where(eq(user.id, staff.userId));
    await sql().insert(chatRoomMember).values({ roomId: room.id, userId: staff.userId });

    expect((await rosterOf(owner, room)).map((member) => member.userId)).toEqual([owner.userId]);
  });

  it('withholds an invite to an account closed after chat cached it', async () => {
    const owner = await chatter('host');
    const room = await createRoom(owner);
    const target = await chatter('closed');
    await rosterOf(target, await createRoom(target));
    await sql().update(player).set({ status: 'closed' }).where(eq(player.userId, target.userId));

    expect((await invite(owner, room, target.userId)).status).toBe(200);

    expect(await invitesTo(target.userId)).toEqual([expect.objectContaining({ withheld: true })]);
  });

  it('answers 503 SERVICE_UNAVAILABLE, and writes no invite, while identity is down', async () => {
    const owner = await chatter('host');
    const room = await createRoom(owner);
    const invitee = await chatter('invitee');

    const refused = await whileIdentity('down', () => invite(owner, room, invitee.userId));

    expect(await errorOf(refused)).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(await invitesTo(invitee.userId)).toEqual([]);
  });

  it('answers 503 on an identity 5xx and 500 on a call identity refuses', async () => {
    const owner = await chatter('host');
    const room = await createRoom(owner);
    const invitee = await chatter('invitee');

    const upstream5xx = await whileIdentity(502, () => invite(owner, room, invitee.userId));
    const upstream4xx = await whileIdentity(400, () => invite(owner, room, invitee.userId));

    expect(await errorOf(upstream5xx)).toEqual({ status: 503, code: 'SERVICE_UNAVAILABLE' });
    expect(await errorOf(upstream4xx)).toEqual({ status: 500, code: 'INTERNAL_SERVER_ERROR' });
    expect(await invitesTo(invitee.userId)).toEqual([]);
  });

  it('serves history while identity is down, with the stored username and no avatar', async () => {
    const authorId = randomUUID();
    const [stored] = await sql()
      .insert(chatMessage)
      .values({ userId: authorId, username: 'stored_name', content: `hello ${authorId}` })
      .returning({ id: chatMessage.id });

    const res = await whileIdentity('down', async () => chatApp.app.request('/chat/global'));

    expect(res.status).toBe(200);
    const messages = ChatMessageSchema.array().parse(await res.json());
    expect(messages.find((message) => message.id === stored?.id)).toMatchObject({
      userId: authorId,
      username: 'stored_name',
      avatarUrl: null,
    });
  });

  it('sends a friend request to an open account and refuses a closed one', async () => {
    const sender = await chatter('friend');
    const open = await chatter('open');
    const closed = await chatter('shut');
    await sql().update(player).set({ status: 'closed' }).where(eq(player.userId, closed.userId));
    identityCalls.length = 0;

    const toOpen = await sender.client.post('/social/friend-requests', {
      targetUserId: open.userId,
    });
    const toClosed = await sender.client.post('/social/friend-requests', {
      targetUserId: closed.userId,
    });

    expect(toOpen.status).toBe(200);
    expect(toClosed.status).toBe(409);
    expect(identityCalls).toContain('/internal/v1/identity/accounts');
  });

  it('refuses an admin on the very next call after demotion or deactivation', async () => {
    const admin = await chatClientFor('admin@oss.dev');
    const [adminRow] = await sql()
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, 'admin@oss.dev'));
    const adminId = adminRow?.id ?? '';
    const list = () => admin.get('/backoffice/chat/messages');

    expect((await list()).status).toBe(200);
    await sql().update(user).set({ role: 'player' }).where(eq(user.id, adminId));
    const demoted = await list();
    await sql().update(user).set({ role: 'admin' }).where(eq(user.id, adminId));
    expect((await list()).status).toBe(200);
    await sql().update(user).set({ isActive: false }).where(eq(user.id, adminId));
    const deactivated = await list();
    await sql().update(user).set({ isActive: true }).where(eq(user.id, adminId));

    expect(demoted.status).toBe(403);
    expect(deactivated.status).toBe(403);
  });
});
