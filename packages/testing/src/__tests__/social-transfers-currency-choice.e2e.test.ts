import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions, DRIZZLE } from '@openora/core/server';
import { seedChatCommands } from '@openora/core/engagement/seed/chat-commands';
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
 * A player can choose which currency a /gift, /rain, or /donate moves in - the recipient
 * receives that exact same currency, never a swap. See social-transfers/AGENTS.md
 * "Sender-chosen currency for gift/rain/donate".
 */

let db: TestDb;
let app: TestApp;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function deposit(client: TestClient, amount: string, currency: string) {
  const res = await client.post('/wallet/deposit', {
    amount,
    currency,
    idempotencyKey: randomUUID(),
  });
  if (res.status !== 200) {
    throw new Error(`deposit failed (${res.status}): ${await res.text()}`);
  }
}

async function balanceFor(client: TestClient, currency: string): Promise<string | undefined> {
  const res = await client.get('/wallet/balances');
  const body = await readJson(res);
  const balances = body.balances as Array<{ currency: string; balance: string }>;
  return balances.find((b) => b.currency === currency)?.balance;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  await seedChatCommands(app.container.get(DRIZZLE).db);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('POST /social-transfers/donate - sender-chosen currency', () => {
  it('credits the recipient in the sender-chosen currency, creating their balance for it, with no swap', async () => {
    const senderUsername = `dsend_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const recipientUsername = `drecv_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const sender = await registerAndMaterializePlayer(app, {
      email: `${senderUsername}@e2e.test`,
      username: senderUsername,
    });
    const recipient = await registerAndMaterializePlayer(app, {
      email: `${recipientUsername}@e2e.test`,
      username: recipientUsername,
    });

    await deposit(sender.client, '50', 'EUR');
    // Recipient holds USD only - never EUR - before the donate lands.
    await deposit(recipient.client, '1', 'USD');
    expect(await balanceFor(recipient.client, 'EUR')).toBeUndefined();

    const res = await sender.client.post('/social-transfers/donate', {
      targetUsername: recipientUsername,
      amount: '10.00000000',
      currency: 'EUR',
      roomId: '__global',
      idempotencyKey: randomUUID(),
    });
    if (res.status !== 200) {
      throw new Error(`donate failed (${res.status}): ${await res.text()}`);
    }
    const body = await readJson(res);
    expect(body.metadata.currency).toBe('EUR');

    const senderEur = await balanceFor(sender.client, 'EUR');
    const recipientEur = await balanceFor(recipient.client, 'EUR');
    expect(Number(senderEur)).toBeCloseTo(40, 5);
    expect(Number(recipientEur)).toBeCloseTo(10, 5);
    // No swap: the recipient's pre-existing USD balance is untouched.
    expect(await balanceFor(recipient.client, 'USD')).toBe('1.000000000000000000');
  });

  it('returns a conflict (insufficient balance) when the sender names a currency they do not hold', async () => {
    const senderUsername = `dnhs_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const recipientUsername = `dnhr_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
    const sender = await registerAndMaterializePlayer(app, {
      email: `${senderUsername}@e2e.test`,
      username: senderUsername,
    });
    // Registered so the target resolves - this test is about the sender's currency choice,
    // not a missing recipient.
    await registerAndMaterializePlayer(app, {
      email: `${recipientUsername}@e2e.test`,
      username: recipientUsername,
    });

    // Sender only ever holds USD.
    await deposit(sender.client, '50', 'USD');

    const res = await sender.client.post('/social-transfers/donate', {
      targetUsername: recipientUsername,
      amount: '10.00000000',
      currency: 'GBP',
      roomId: '__global',
      idempotencyKey: randomUUID(),
    });

    expect(res.status).toBe(409);
    // The sender's USD balance is untouched - the failed GBP attempt never moves money.
    expect(await balanceFor(sender.client, 'USD')).toBe('50.000000000000000000');
  });
});
