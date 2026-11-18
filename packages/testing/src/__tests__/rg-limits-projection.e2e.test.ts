import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DRIZZLE } from '@openora/core/server';
import { WALLET_COMMANDS } from '@openora/core/contracts';
import {
  registerAndMaterializePlayer,
  type TestDb,
  type TestApp,
  type TestClient,
  bootE2e,
  closeE2e,
} from '../index.js';

// A wager limit the player sets binds the ledger in the request that sets it: no outbox delivery
// stands between the limit and the next stake (ADR-0055).

let db: TestDb;
let app: TestApp;

async function fundedPlayer() {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `rg-limits-${randomUUID()}@e2e.test`,
  });
  const res = await client.post('/wallet/deposit', {
    idempotencyKey: randomUUID(),
    amount: '100',
    currency: 'USD',
  });
  expect(res.status).toBe(200);
  return { client, userId };
}

const setWagerLimit = async (client: TestClient, amount: string) => {
  const res = await client.put('/compliance/limits', {
    type: 'wager',
    amount,
    minutes: null,
    currency: 'USD',
    period: 'daily',
  });
  expect(res.status).toBe(200);
};

const bet = (userId: string, amount: string) =>
  app.container
    .get(WALLET_COMMANDS)
    .debit(app.container.get(DRIZZLE).db, { userId, amount, type: 'bet' });

const refused = { name: 'RgLimitExceededError', data: { reason: 'wager_limit_exceeded' } };

beforeAll(async () => {
  ({ db, app } = await bootE2e());
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('ledger limits projection e2e', () => {
  it('refuses a bet over the wager limit the player set', async () => {
    const { client, userId } = await fundedPlayer();
    await setWagerLimit(client, '20');

    await expect(bet(userId, '15')).resolves.toMatchObject({ ok: true });
    await expect(bet(userId, '10')).rejects.toMatchObject(refused);
  });

  it('refuses the next bet straight after the player lowers the limit', async () => {
    const { client, userId } = await fundedPlayer();
    await setWagerLimit(client, '50');
    await expect(bet(userId, '15')).resolves.toMatchObject({ ok: true });

    await setWagerLimit(client, '20');

    await expect(bet(userId, '10')).rejects.toMatchObject(refused);
  });
});
