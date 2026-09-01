import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import { GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
} from '../index.js';

/**
 * Route-level walkthrough for chat-commands `mentionSearch`
 * (GET /chat-command/mention-search) over the real app. The service unit tests
 * cover the branch matrix with fakes; this suite proves the behaviour survives
 * the real router, auth guard and directory binding. Nobody holds a realtime
 * connection in a booted test app, so every registered player here is offline -
 * which is exactly the case the online-only filter used to drop.
 */

let db: TestDb;
let app: TestApp;

async function registerPlayer(prefix: string) {
  const username = `${prefix.slice(0, 7)}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
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

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const basePlugins = await loadExtensions();
  app = await bootTestApp({ plugins: basePlugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('mentionSearch: a typed query reaches players who are not online', () => {
  it('returns an offline player matching the query', async () => {
    const searcher = await registerPlayer('searcher');
    const target = await registerPlayer('mentionable');

    const res = await searcher.client.get(mentionUrl(target.username));

    expect(res.status).toBe(200);
    const results = (await readJson(res)) as { userId: string; username: string }[];
    expect(results).toContainEqual({ userId: target.userId, username: target.username });
  });

  it('never returns the caller', async () => {
    const searcher = await registerPlayer('selfsearch');

    const results = (await readJson(await searcher.client.get(mentionUrl(searcher.username)))) as {
      userId: string;
    }[];

    expect(results.map((r) => r.userId)).not.toContain(searcher.userId);
  });
});

describe('mentionSearch: an empty query stays scoped to the room', () => {
  it('returns [] when nobody is connected to the room', async () => {
    const searcher = await registerPlayer('emptyquery');
    await registerPlayer('notconnected');

    const res = await searcher.client.get(mentionUrl(''));

    expect(res.status).toBe(200);
    expect(await readJson(res)).toEqual([]);
  });
});

describe('mentionSearch: authorization', () => {
  it('401s without a session', async () => {
    const res = await app.app.request(mentionUrl('anyone'), { method: 'GET' });

    expect(res.status).toBe(401);
  });
});
