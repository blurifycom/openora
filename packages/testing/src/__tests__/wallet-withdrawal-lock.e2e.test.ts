import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  setupTestDb,
  bootTestApp,
  registerAndMaterializePlayer,
  asAdmin,
  seedMinimal,
  type TestDb,
  type TestApp,
  type TestClient,
} from '../index.js';

/**
 * E2E for the `withdrawal_lock` tag over real HTTP + Postgres + the real tag module bound
 * to `PLAYER_TAGS`: the lock is placed and released through the tag routes, and the wallet
 * routes read it from there rather than from a stub.
 */

let db: TestDb;
let app: TestApp;
let admin: TestClient;

// oxlint-disable-next-line typescript/no-explicit-any -- ad-hoc JSON shape assertions in tests
async function readJson(res: Response): Promise<any> {
  return res.json();
}

async function fundedPlayer() {
  const player = await registerAndMaterializePlayer(app, {
    email: `withdrawal-lock-${randomUUID()}@e2e.test`,
  });
  await player.client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount: '500',
    currency: 'USD',
  });
  return player;
}

async function requestWithdrawal(client: TestClient) {
  return client.post('/wallet/withdraw', {
    idempotencyKey: randomUUID(),
    amount: '50',
    currency: 'USD',
  });
}

function approve(transactionId: string) {
  return admin.post(`/wallet/withdrawals/${transactionId}/approve`, {
    withdrawalId: transactionId,
  });
}

function release(playerId: string, body: Record<string, unknown>) {
  return admin.request(`/player/${playerId}/player-tag/withdrawal_lock`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function withdrawalStatus(transactionId: string): Promise<string> {
  const res = await admin.get('/wallet/withdrawals?page=1&limit=100');
  const body = await readJson(res);
  return body.items.find((item: { transactionId: string }) => item.transactionId === transactionId)
    ?.status;
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  process.env['NODE_ENV'] ??= 'test';

  db = await setupTestDb();
  const plugins = await loadExtensions();
  app = await bootTestApp({ plugins, databaseUrl: db.url });
  await seedMinimal(app.container, { playerCount: 0 });
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await db?.dispose();
});

describe('withdrawal_lock through the real tag and wallet routes', () => {
  it('refuses new and queued withdrawals while locked, and approves the queued one once released', async () => {
    const { client, playerId } = await fundedPlayer();
    const queuedRes = await requestWithdrawal(client);
    expect(queuedRes.status).toBe(200);
    const queued = await readJson(queuedRes);
    expect(queued.status).toBe('pending');

    const lockRes = await admin.post(`/player/${playerId}/player-tag`, {
      tagKey: 'withdrawal_lock',
      assignReason: 'E2E: investigation hold',
      assignActor: 'manual',
    });
    expect(lockRes.status).toBe(200);

    const refused = await requestWithdrawal(client);
    expect(refused.status).toBe(409);
    expect((await readJson(refused)).data).toEqual({ reason: 'withdrawal_locked' });

    const approveWhileLocked = await approve(queued.transactionId);
    expect(approveWhileLocked.status).toBe(409);
    expect((await readJson(approveWhileLocked)).data).toEqual({ reason: 'withdrawal_locked' });
    expect(await withdrawalStatus(queued.transactionId)).toBe('pending');

    const queue = await readJson(await admin.get('/wallet/withdrawals?page=1&limit=100'));
    expect(
      queue.items.find(
        (item: { transactionId: string }) => item.transactionId === queued.transactionId,
      )?.withdrawalLocked,
    ).toBe(true);

    const releaseWithoutReason = await release(playerId, { removalActor: 'manual' });
    expect(releaseWithoutReason.status).toBe(400);

    const releaseRes = await release(playerId, {
      removalReason: 'E2E: investigation closed',
      removalActor: 'manual',
    });
    expect(releaseRes.status).toBe(200);

    const approved = await approve(queued.transactionId);
    expect(approved.status).toBe(200);
    expect((await readJson(approved)).status).toBe('completed');

    const audit = await readJson(await admin.get(`/audit/logs?resourceId=${playerId}&limit=50`));
    const tagActions = audit.items
      .filter(
        (entry: { after: { tagKey?: string } | null }) => entry.after?.tagKey === 'withdrawal_lock',
      )
      .map((entry: { action: string }) => entry.action);
    expect(tagActions).toEqual(
      expect.arrayContaining(['tag.player.assigned', 'tag.player.removed']),
    );
  });
});
