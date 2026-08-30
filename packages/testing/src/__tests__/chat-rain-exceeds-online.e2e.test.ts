import { describe, it, expect, beforeAll, afterAll } from 'vitest';
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

type TestPlayer = Awaited<ReturnType<typeof registerAndMaterializePlayer>>;

/**
 * Covers the gap left by chat-rain-notification.e2e.test.ts: that spec only
 * exercises recipientCount == online count. Here the sender requests more
 * recipients than are actually online, so the split must degrade to the
 * actual online count (fewer recipients, no crash, no over-crediting) - and
 * every acceptance criterion (auto-credit, per-recipient notification amount,
 * one sender history entry, one history entry per recipient) is verified via
 * a follow-up request against real state, not implementation internals.
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

async function getBalance(client: TestClient): Promise<number> {
  const res = await client.get('/wallet/balance');
  if (res.status !== 200) {
    throw new Error(`getBalance failed (${res.status}): ${await res.text()}`);
  }
  const body = await readJson(res);
  return Number(body.balance);
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

describe('chat rain requesting more recipients than are online', () => {
  let sender: TestPlayer;
  let recipientA: TestPlayer;
  let recipientB: TestPlayer;
  let recipientC: TestPlayer;

  beforeAll(async () => {
    sender = await registerAndMaterializePlayer(app, {
      email: `rain-over-sender-${randomUUID()}@e2e.test`,
    });
    recipientA = await registerAndMaterializePlayer(app, {
      email: `rain-over-a-${randomUUID()}@e2e.test`,
    });
    recipientB = await registerAndMaterializePlayer(app, {
      email: `rain-over-b-${randomUUID()}@e2e.test`,
    });
    // recipientC exists but is NOT marked online - it must never be credited or notified.
    recipientC = await registerAndMaterializePlayer(app, {
      email: `rain-over-c-${randomUUID()}@e2e.test`,
    });

    markOnline(app, null, recipientA.userId);
    markOnline(app, null, recipientB.userId);

    await deposit(recipientA.client, '1');
    await deposit(recipientB.client, '1');
    await deposit(recipientC.client, '1');
    await deposit(sender.client, '100');
  }, 30_000);

  it('degrades to the actual online recipient count, credits exactly them, and records history both sides', async () => {
    const senderBalanceBefore = await getBalance(sender.client);

    // Requests 5 recipients but only 2 (A, B) are online - split must be based
    // on the REQUESTED count (5) per doSendRain/calculateRainSplit, so
    // perRecipient = floor(50/5) = 10, totalDistributed = 10 * 2 = 20.
    const rainRes = await sender.client.post('/chat-command/rain', {
      amount: '50',
      recipientCount: 5,
      roomId: '__global',
      idempotencyKey: randomUUID(),
    });
    const rainBody = await readJson(rainRes);
    if (rainRes.status !== 200) {
      throw new Error(`rain failed (${rainRes.status}): ${JSON.stringify(rainBody)}`);
    }
    expect(rainBody.metadata.recipientCount).toBe(2);
    expect(Number(rainBody.metadata.perRecipient)).toBeCloseTo(10, 2);
    expect(Number(rainBody.metadata.amount)).toBeCloseTo(20, 2);

    // Criterion 2: each recipient auto-credited, no claim step.
    expect(await getBalance(recipientA.client)).toBeCloseTo(11, 2);
    expect(await getBalance(recipientB.client)).toBeCloseTo(11, 2);
    // The offline player must be untouched - no over-crediting beyond the degraded set.
    expect(await getBalance(recipientC.client)).toBeCloseTo(1, 2);

    // Criterion 3: each recipient's own notification carries THEIR share (10.00), not
    // the pooled total (20.00).
    for (const recipient of [recipientA, recipientB]) {
      const notifyRes = await recipient.client.get('/notifications');
      const notifications = await readJson(notifyRes);
      const found = (notifications as Array<{ type: string; body: string }>).find(
        (n) => n.type === 'chat.rain.received',
      );
      expect(found).toBeTruthy();
      expect(found?.body).toContain('10.00');
      expect(found?.body).not.toContain('20.00');
    }
    const cNotifyRes = await recipientC.client.get('/notifications');
    const cNotifications = await readJson(cNotifyRes);
    expect(
      (cNotifications as Array<{ type: string }>).find((n) => n.type === 'chat.rain.received'),
    ).toBeUndefined();

    // Criterion 4: exactly one rain debit entry in the sender's history, and exactly
    // one rain credit entry in each recipient's history.
    const senderTxRes = await sender.client.get('/wallet/transactions?page=1&limit=50');
    const senderTx = await readJson(senderTxRes);
    const senderRainRows = (
      senderTx.items as Array<{ type: string; amount: string; direction: string | null }>
    ).filter((t) => t.type === 'rain');
    expect(senderRainRows).toHaveLength(1);
    expect(Number(senderRainRows[0]?.amount)).toBeCloseTo(20, 2);

    for (const recipient of [recipientA, recipientB]) {
      const txRes = await recipient.client.get('/wallet/transactions?page=1&limit=50');
      const tx = await readJson(txRes);
      const rainRows = (tx.items as Array<{ type: string; amount: string }>).filter(
        (t) => t.type === 'rain',
      );
      expect(rainRows).toHaveLength(1);
      expect(Number(rainRows[0]?.amount)).toBeCloseTo(10, 2);
    }

    const senderBalanceAfter = await getBalance(sender.client);
    expect(senderBalanceBefore - senderBalanceAfter).toBeCloseTo(20, 2);
  });
});
