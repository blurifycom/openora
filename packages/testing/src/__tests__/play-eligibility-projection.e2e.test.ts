import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '@openora/core/server';
import { WALLET_COMMANDS } from '@openora/core/contracts';
import {
  registerAndMaterializePlayer,
  asAdmin,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
} from '../index.js';

// The ledger learns a new player may stake in the registration transaction itself: no boot
// backfill and no outbox delivery stands between signing up and the first bet.

let db: TestDb;
let app: TestApp;
let admin: TestClient;

async function registeredAndFunded() {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `play-eligibility-${randomUUID()}@e2e.test`,
  });
  const res = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount: '100',
    currency: 'USD',
  });
  expect(res.status).toBe(200);
  return userId;
}

const bet = (userId: string) =>
  app.container
    .get(WALLET_COMMANDS)
    .debit(app.container.get(DRIZZLE).db, { userId, amount: '10', type: 'bet' });

beforeAll(async () => {
  ({ db, app } = await bootE2e());
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('play eligibility projection e2e', () => {
  it('lets a player who just registered place a bet', async () => {
    const userId = await registeredAndFunded();

    await expect(bet(userId)).resolves.toMatchObject({ ok: true });
  });

  it('refuses the bet once an admin self-excludes that player', async () => {
    const userId = await registeredAndFunded();

    const res = await admin.post(`/compliance/players/${userId}/self-exclusion`, {
      isPermanent: true,
      reason: 'player requested, permanent',
      confirm: true,
    });
    expect(res.status).toBe(200);

    await expect(bet(userId)).rejects.toMatchObject({ name: 'WalletRgRestrictedError' });
  });
});
