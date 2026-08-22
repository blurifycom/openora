import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { loadExtensions } from '@openora/core/server';
import {
  asAdmin,
  bootTestApp,
  registerAndMaterializePlayer,
  seedMinimal,
  setupTestDb,
  type TestApp,
  type TestDb,
} from '../index.js';

let db: TestDb;
let testApp: TestApp;

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected JSON object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

// Uses the shared helper rather than posting to /identity/register directly: the
// registration contract owns which fields are mandatory, and a hand-rolled body here
// silently rots the moment one is added.
async function registerPlayer() {
  const { client, userId } = await registerAndMaterializePlayer(testApp, {
    email: `manual-adjustment-${randomUUID()}@e2e.test`,
  });
  return { player: client, userId };
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['NODE_ENV'] ??= 'test';
  db = await setupTestDb();
  testApp = await bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url });
  await seedMinimal(testApp.container, { playerCount: 0 });
}, 60_000);

afterAll(async () => {
  await testApp?.close();
  await db?.dispose();
});

describe('manual wallet adjustment', () => {
  it('allows Super Admin credit, writes private admin history and audit, and rejects a player', async () => {
    const { player, userId } = await registerPlayer();
    const admin = await asAdmin(testApp.app);
    const idempotencyKey = randomUUID();

    const denied = await player.post('/wallet/manual-adjustments', {
      userId,
      direction: 'credit',
      amount: '10',
      currency: 'USD',
      reason: 'attempted self-credit',
      idempotencyKey: randomUUID(),
    });
    expect(denied.status).toBe(403);

    const adjusted = await admin.post('/wallet/manual-adjustments', {
      userId,
      direction: 'credit',
      amount: '10',
      currency: 'USD',
      reason: 'support compensation',
      idempotencyKey,
    });
    expect(adjusted.status).toBe(200);
    const adjustmentRaw: unknown = await adjusted.json();
    const adjustmentBody = object(adjustmentRaw);
    const transactionId = adjustmentBody['transactionId'];
    if (typeof transactionId !== 'string') {
      throw new Error('adjustment has no transactionId');
    }

    const balanceRaw: unknown = await (await player.get('/wallet/balance')).json();
    const balance = object(balanceRaw);
    expect(balance['balance']).toBe('10.000000000000000000');

    const historyRaw: unknown = await (
      await admin.get(`/wallet/transactions/${userId}?page=1&limit=20`)
    ).json();
    const history = object(historyRaw);
    const items = history['items'];
    if (!Array.isArray(items)) {
      throw new Error('admin history has no items');
    }
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: transactionId,
          type: 'manual_credit',
          reviewReason: 'support compensation',
        }),
      ]),
    );

    const auditRaw: unknown = await (
      await admin.get(
        `/audit/logs?resourceId=${transactionId}&action=wallet.manual_adjustment.created`,
      )
    ).json();
    const audit = object(auditRaw);
    expect(audit['items']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'wallet.manual_adjustment.created' }),
      ]),
    );
  });
});
