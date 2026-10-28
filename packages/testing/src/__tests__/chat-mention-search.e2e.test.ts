import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CHAT_ROOM_ID, MESSAGE_BROKER } from '@openora/core/contracts';
import { MentionResultSchema } from '@openora/core/engagement/contracts/chat-commands';
import { ChatMessageSchema, ChatRoomSchema } from '@openora/core/engagement/contracts/chat';
import {
  registerAndMaterializePlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
  uniqueUsername,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

async function registerPlayer(prefix: string) {
  const username = uniqueUsername(prefix);
  const registered = await registerAndMaterializePlayer(app, {
    email: `${username}@e2e.test`,
    username,
  });
  return { ...registered, username };
}

function mentionUrl(q: string, roomId: string = GLOBAL_CHAT_ROOM_ID) {
  const params = new URLSearchParams({ q, limit: '20', roomId });
  return `/chat-command/mention-search?${params.toString()}`;
}

async function readMentionResults(res: Response) {
  return MentionResultSchema.array().parse(await res.json());
}

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('mentionSearch: a typed query reaches players who are not online', () => {
  it('returns an offline player matching the query', async () => {
    const searcher = await registerPlayer('searcher');
    const target = await registerPlayer('mentionable');

    const res = await searcher.client.get(mentionUrl(target.username));

    expect(res.status).toBe(200);
    const results = await readMentionResults(res);
    expect(results).toContainEqual({ userId: target.userId, username: target.username });
  });

  it('never returns the caller', async () => {
    const searcher = await registerPlayer('selfsearch');

    const results = await readMentionResults(
      await searcher.client.get(mentionUrl(searcher.username)),
    );

    expect(results.map((r) => r.userId)).not.toContain(searcher.userId);
  });

  it('does not treat wildcard query characters as player search patterns', async () => {
    const searcher = await registerPlayer('wildsearch');
    await registerPlayer('wildtarget');

    const res = await searcher.client.get(mentionUrl('%'));

    expect(res.status).toBe(200);
    expect(await readMentionResults(res)).toEqual([]);
  });
});

describe('mentionSearch: an empty query stays scoped to the room', () => {
  it('returns [] when nobody is connected to the room', async () => {
    const searcher = await registerPlayer('emptyquery');
    await registerPlayer('notconnected');

    const res = await searcher.client.get(mentionUrl(''));

    expect(res.status).toBe(200);
    expect(await readMentionResults(res)).toEqual([]);
  });
});

describe('mentionSearch: authorization', () => {
  it('401s without a session', async () => {
    const res = await app.app.request(mentionUrl('anyone'), { method: 'GET' });

    expect(res.status).toBe(401);
  });

  it("refuses a private room's online list to a non-member and serves its members", async () => {
    const owner = await registerPlayer('privowner');
    const outsider = await registerPlayer('outsider');
    const created = await owner.client.post('/chat/rooms/private', {
      name: `room-${randomUUID()}`,
    });
    expect(created.status).toBe(200);
    const room = ChatRoomSchema.parse(await created.json());

    expect((await outsider.client.get(mentionUrl('', room.id))).status).toBe(403);
    expect((await owner.client.get(mentionUrl('', room.id))).status).toBe(200);
  });
});

describe('mention notification', () => {
  const WAIT = { timeout: 10_000, interval: 100 };

  type Player = Awaited<ReturnType<typeof registerPlayer>>;
  type MentionRow = { params: Record<string, string> | null; data: Record<string, string> | null };

  async function mentionRows(player: Player): Promise<MentionRow[]> {
    const res = await player.client.get('/notifications');
    expect(res.status).toBe(200);
    const { items } = (await res.json()) as { items: (MentionRow & { type: string })[] };
    return items.filter((n) => n.type === 'chat.mention');
  }

  async function waitForMentions(player: Player, count: number) {
    return vi.waitFor(async () => {
      const rows = await mentionRows(player);
      expect(rows).toHaveLength(count);
      return rows;
    }, WAIT);
  }

  async function postGlobal(author: Player, content: string) {
    const res = await author.client.post('/chat/global', { content });
    expect(res.status).toBe(200);
    return ChatMessageSchema.parse(await res.json());
  }

  async function publicRoomWith(...members: Player[]) {
    const created = await admin.post('/backoffice/chat/rooms', {
      name: `public-${randomUUID()}`,
      slug: `public-${randomUUID()}`,
      category: 'games-sports',
    });
    expect(created.status).toBe(200);
    const room = ChatRoomSchema.parse(await created.json());
    for (const member of members) {
      expect((await member.client.post(`/chat/rooms/${room.id}/join`)).status).toBe(200);
    }
    return room;
  }

  function publishMention(eventId: string, payload: Record<string, unknown>) {
    return app.container.get(MESSAGE_BROKER).publish({
      eventId,
      topic: 'chat.user.mentioned',
      payload,
      occurredAt: new Date().toISOString(),
      schemaVersion: 1,
    });
  }

  it('names the author of a room mention and links the room and message', async () => {
    const author = await registerPlayer('rauthor');
    const target = await registerPlayer('rtarget');
    const room = await publicRoomWith(author, target);

    const sent = await author.client.post(`/chat/rooms/${room.id}/messages`, {
      content: `hi @${target.username}`,
    });
    expect(sent.status).toBe(200);
    const message = ChatMessageSchema.parse(await sent.json());

    expect(await waitForMentions(target, 1)).toEqual([
      expect.objectContaining({
        params: { byUsername: author.username },
        data: { roomId: room.id, messageId: message.id },
      }),
    ]);
  });

  it('names the author of a global-chat mention', async () => {
    const author = await registerPlayer('gauthor');
    const target = await registerPlayer('gtarget');

    const message = await postGlobal(author, `hey @${target.username}`);

    expect(await waitForMentions(target, 1)).toEqual([
      expect.objectContaining({
        params: { byUsername: author.username },
        data: { messageId: message.id },
      }),
    ]);
  });

  it('does not notify the author of their own mention', async () => {
    const author = await registerPlayer('sauthor');
    const target = await registerPlayer('starget');

    await postGlobal(author, `@${author.username} @${target.username}`);

    expect((await waitForMentions(target, 1))[0]?.params).toEqual({ byUsername: author.username });
    expect(await mentionRows(author)).toEqual([]);
  });

  it('does not notify a player who blocked the author', async () => {
    const author = await registerPlayer('bauthor');
    const blocker = await registerPlayer('blocker');
    const target = await registerPlayer('btarget');
    expect((await blocker.client.post('/chat/blocks', { blockedId: author.userId })).status).toBe(
      200,
    );

    await postGlobal(author, `@${blocker.username} @${target.username}`);

    expect((await waitForMentions(target, 1))[0]?.params).toEqual({ byUsername: author.username });
    expect(await mentionRows(blocker)).toEqual([]);
  });

  it('does not notify a player who ignores the author in a room', async () => {
    const author = await registerPlayer('iauthor');
    const ignorer = await registerPlayer('ignorer');
    const target = await registerPlayer('itarget');
    const room = await publicRoomWith(author, ignorer, target);
    expect((await ignorer.client.post('/chat/ignores', { ignoredId: author.userId })).status).toBe(
      200,
    );

    const sent = await author.client.post(`/chat/rooms/${room.id}/messages`, {
      content: `@${ignorer.username} @${target.username}`,
    });
    expect(sent.status).toBe(200);

    await waitForMentions(target, 1);
    expect(await mentionRows(ignorer)).toEqual([]);
  });

  it('creates one row when the same mention event is delivered twice', async () => {
    const author = await registerPlayer('dauthor');
    const target = await registerPlayer('dtarget');
    const payload = {
      mentionedUserId: target.userId,
      byUserId: author.userId,
      byUsername: author.username,
      roomId: null,
    };
    const eventId = randomUUID();
    const messageId = randomUUID();

    await publishMention(eventId, { ...payload, messageId });
    await publishMention(eventId, { ...payload, messageId });
    // A later event to the same player marks the redelivery as handled.
    await publishMention(randomUUID(), { ...payload, messageId: randomUUID() });

    const rows = await waitForMentions(target, 2);
    expect(rows.filter((row) => row.data?.messageId === messageId)).toHaveLength(1);
  });

  it('still notifies on a mention event queued without the author username', async () => {
    const target = await registerPlayer('otarget');
    const messageId = randomUUID();

    await publishMention(randomUUID(), {
      mentionedUserId: target.userId,
      byUserId: randomUUID(),
      roomId: null,
      messageId,
    });

    expect(await waitForMentions(target, 1)).toEqual([
      expect.objectContaining({ params: null, data: { messageId } }),
    ]);
  });
});
