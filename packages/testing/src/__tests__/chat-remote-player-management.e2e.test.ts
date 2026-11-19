import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import { CHAT_BLOCK_READER_ROUTES } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import {
  asPlayer,
  bootTestApp,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestDb,
} from '../index.js';

// A money service: player-management and what it needs, with no chat module, so none of its
// routes and none of chat's tables. Chat's block read comes from the chat service over the
// signed internal API, a call to the chat origin answered here as that service would.
const CHAT_SERVICE_URL = 'http://chat.internal';
const MANIFEST = [
  'player-management',
  'chat-remote',
  'gaming',
  'audit',
  'identity',
  'wallet',
  'compliance',
  'mail',
  'iam',
  'exchange-rate',
  'tag',
].join(',');
const ENV = {
  SERVICE_MANIFEST: MANIFEST,
  SERVICE_NAME: 'money-e2e',
  REALTIME_NAMESPACE: 'money-e2e',
  INTERNAL_API_SECRETS: 'x'.repeat(32),
  CHAT_SERVICE_URL,
};
const SEEDED_PLAYER = (n: number) => `player.${n}@demo.igaming.dev`;

type ChatMode = { excluded: string[] } | 'down';

let db: TestDb;
let money: TestApp;
let chat: ChatMode = { excluded: [] };
const chatCalls: { path: string; caller: string | null; signed: boolean }[] = [];
const realFetch = globalThis.fetch;

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

async function searchAs(
  client: Awaited<ReturnType<typeof asPlayer>>,
  query: string,
): Promise<{ status: number; usernames: string[] }> {
  const res = await client.get(`/players/search?q=${encodeURIComponent(query)}&limit=20`);
  const body: unknown = res.ok ? await res.json() : [];
  const usernames = Array.isArray(body)
    ? body.map((hit: { username: string }) => hit.username).sort()
    : [];
  return { status: res.status, usernames };
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(CHAT_SERVICE_URL)) {
      return realFetch(input, init);
    }
    const headers = new Headers(init?.headers);
    const path = new URL(url).pathname;
    chatCalls.push({
      path,
      caller: headers.get('x-openora-service'),
      signed: headers.has('x-openora-signature'),
    });
    if (chat === 'down') {
      throw new TypeError('fetch failed');
    }
    return Response.json({ userIds: chat.excluded });
  });
  db = await setupTestDb();
  money = await withEnv(ENV, async () =>
    bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url }),
  );
  await seedMinimal(money.container, { playerCount: 3 });
}, 90_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await money?.close();
  await db?.dispose();
});

describe('player-management on a service that does not load chat', () => {
  it('boots with chat absent: no chat routes, health up', async () => {
    expect((await money.app.request('/health')).status).toBe(200);
    expect((await money.app.request('/chat/rooms')).status).toBe(404);
  });

  it('reads the viewer exclusions from the chat service and filters the search by them', async () => {
    const viewer = await asPlayer(money.app, { email: SEEDED_PLAYER(1) });
    chat = { excluded: [] };
    const baseline = await searchAs(viewer, 'player');
    const hiddenUsername = baseline.usernames.find((name) => name !== 'player_1');
    expect(hiddenUsername).toBeDefined();
    const [hidden] = await money.container
      .get(DRIZZLE)
      .db.select({ id: user.id })
      .from(user)
      .where(eq(user.username, hiddenUsername ?? ''));
    chat = { excluded: [hidden?.id ?? ''] };
    chatCalls.length = 0;

    const filtered = await searchAs(viewer, 'player');

    expect(filtered.status).toBe(200);
    expect(filtered.usernames).toEqual(
      baseline.usernames.filter((name) => name !== hiddenUsername),
    );
    expect(chatCalls.map((call) => call.path)).toEqual([
      `/internal/v1${CHAT_BLOCK_READER_ROUTES.excluded}`,
    ]);
    expect(chatCalls[0]).toMatchObject({ caller: 'money-e2e', signed: true });
  });

  it('answers 503 rather than an unfiltered list while the chat service is down', async () => {
    const viewer = await asPlayer(money.app, { email: SEEDED_PLAYER(1) });
    chat = 'down';

    try {
      expect((await searchAs(viewer, 'player')).status).toBe(503);
    } finally {
      chat = { excluded: [] };
    }
  });
});
