import { afterAll, beforeAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { TurnoverDisabledError, WALLET_COMMANDS } from '@openora/core/contracts';
import { walletTurnover, walletTurnoverEntry } from '@openora/core/wallet/schema';
import {
  bootE2e,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestDb,
} from '../index.js';

let db: TestDb;
let app: TestApp;

const drizzle = () => app.container.get(DRIZZLE).db;

beforeAll(async () => {
  ({ db, app } = await bootE2e());
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

it('reads as off with zeros and writes nothing while the multiplier is 0', async () => {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `turnover-off-${randomUUID()}@e2e.test`,
  });
  const deposit = await client.post('/wallet/deposit', {
    amount: '50',
    currency: 'USD',
    idempotencyKey: randomUUID(),
  });
  expect(deposit.status).toBe(200);

  const summary = await client.get('/wallet/turnover');
  expect(summary.status).toBe(200);
  expect(await readJson(summary)).toEqual({
    enabled: false,
    pivotCurrency: 'USD',
    required: '0',
    progress: '0',
    remaining: '0',
    dustThreshold: '0.01',
    locked: false,
    pendingCount: 0,
    updatedAt: null,
  });
  const entries = await client.get('/wallet/turnover/entries');
  expect(await readJson(entries)).toEqual({ items: [], nextCursor: null });

  await expect(
    drizzle().transaction(async (tx) => {
      const commands = app.container.get(WALLET_COMMANDS);
      if (!commands.addTurnoverRequirement) {
        throw new Error('addTurnoverRequirement is not bound');
      }
      return commands.addTurnoverRequirement(tx, {
        userId,
        currency: 'USD',
        requiredInCurrency: '10',
        source: 'grant_conversion',
        sourceRef: randomUUID(),
      });
    }),
  ).rejects.toBeInstanceOf(TurnoverDisabledError);

  expect(
    await drizzle().select().from(walletTurnover).where(eq(walletTurnover.userId, userId)),
  ).toEqual([]);
  expect(
    await drizzle()
      .select()
      .from(walletTurnoverEntry)
      .where(eq(walletTurnoverEntry.userId, userId)),
  ).toEqual([]);
});
