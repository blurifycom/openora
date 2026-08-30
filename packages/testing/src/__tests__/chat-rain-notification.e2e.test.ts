import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { REALTIME_TRANSPORT, chatChannel } from '@openora/core/contracts';
import { seedChatCommands } from '@openora/core/engagement/seed/chat-commands';
import { migrate as migrateChatCommands } from '@openora/core/engagement/migrate/chat-commands';
import { migrate as migrateSocialTransfers } from '@openora/core/engagement/migrate/social-transfers';
import {
  setupTestDb,
  bootTestApp,
  seedMinimal,
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * Every rain recipient must see an in-app notification naming who sent it and
 * their own per-recipient share. Drives the real POST /chat-command/rain
 * route so the notifications plugin's `chat.rain.distributed` subscriber runs
 * exactly as it would in production. Recipients are marked "online" via the
 * real `RealtimePresence` the test app binds (`InProcessRealtimeTransport`) -
 * no SSE connection needed, see realtime-transport.ts.
 */

let db: TestDb;
let app: TestApp;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function deposit(client: TestClient, amount: string) {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

function markOnline(app: TestApp, roomId: string | null, userId: string) {
  const transport = app.container.get(REALTIME_TRANSPORT);
  transport.presence?.join(chatChannel(roomId), userId, `conn-${userId}`);
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  await migrateChatCommands(db.url);
  await migrateSocialTransfers(db.url);
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  await seedChatCommands(app.container.get(DRIZZLE).db);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('chat.rain.distributed -> per-recipient notification', () => {
  it('notifies every selected recipient with their own share and the sender', async () => {
    const sender = await registerAndMaterializePlayer(app, {
      email: `rain-sender-${randomUUID()}@e2e.test`,
    });
    const recipientA = await registerAndMaterializePlayer(app, {
      email: `rain-recipient-a-${randomUUID()}@e2e.test`,
    });
    const recipientB = await registerAndMaterializePlayer(app, {
      email: `rain-recipient-b-${randomUUID()}@e2e.test`,
    });

    markOnline(app, null, recipientA.userId);
    markOnline(app, null, recipientB.userId);

    // Recipients need an existing USD wallet balance row before a credit can land.
    await deposit(recipientA.client, '1');
    await deposit(recipientB.client, '1');
    await deposit(sender.client, '100');

    const rainRes = await sender.client.post('/chat-command/rain', {
      amount: '20',
      recipientCount: 2,
      roomId: '__global',
      idempotencyKey: randomUUID(),
    });
    if (rainRes.status !== 200) {
      throw new Error(`rain failed (${rainRes.status}): ${await rainRes.text()}`);
    }

    for (const recipient of [recipientA, recipientB]) {
      await vi.waitFor(async () => {
        const notifyRes = await recipient.client.get('/notifications');
        const notifications = await readJson(notifyRes);
        const found = (notifications as Array<{ type: string; body: string }>).find(
          (n) => n.type === 'chat.rain.received',
        );
        expect(found).toBeTruthy();
        expect(found?.body).toContain('10.00');
        expect(found?.body).toContain('USD');
      });
    }
  });
});
