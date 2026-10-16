import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import { MentionResultSchema } from '@openora/core/engagement/contracts/chat-commands';
import { ChatRoomSchema } from '@openora/core/engagement/contracts/chat';
import {
  registerAndMaterializePlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  uniqueUsername,
  bootE2e,
  closeE2e,
} from '../index.js';

let db: TestDb;
let app: TestApp;

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
  await asAdmin(app.app);
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
