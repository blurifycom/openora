import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { DRIZZLE, moneyCompare } from '@openora/core/server';
import type { SportsbookBetResult } from '@openora/core/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { adminRole, adminRoleAssignment } from '@openora/core/iam/schema';
import {
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import {
  PROVIDER,
  acceptedBet,
  bootSportsbookApp,
  deposit,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  txId,
} from './fixtures/sportsbook.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const expectMoney = (actual: unknown, expected: string, label: string) =>
  expect(moneyCompare(String(actual), expected) === 0, `${label}: ${String(actual)}`).toBe(true);

const progressOf = async (client: TestClient) => {
  const res = await client.get('/wallet/turnover');
  expect(res.status).toBe(200);
  return String((await readJson(res)).progress);
};

const settle = (providerBetId: string, result: SportsbookBetResult, payout: string) =>
  ledgerOf(app)
    .settle({ provider: PROVIDER, providerTxId: txId(), providerBetId, result, payout })
    .then(expectApplied);

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp({
    fixtures: [
      { id: 'testing-wallet-turnover-config', file: 'test-wallet-turnover-config-plugin.ts' },
    ],
  }));
  const registered = await registerAndMaterializePlayer(app, {
    email: `turnover-sb-admin-${randomUUID()}@e2e.test`,
  });
  const drizzle = app.container.get(DRIZZLE).db;
  await drizzle.update(user).set({ role: 'admin' }).where(eq(user.id, registered.userId));
  const [role] = await drizzle.select().from(adminRole).where(eq(adminRole.key, 'super-admin'));
  if (!role) {
    throw new Error('no seeded super-admin role');
  }
  await drizzle
    .insert(adminRoleAssignment)
    .values({ userId: registered.userId, roleId: role.id })
    .onConflictDoNothing();
  admin = registered.client;
  await enableSportsbook(app, {}, admin);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('a sportsbook stake placed before the deposit it settles after', () => {
  it('counts nothing toward a requirement that did not exist when it was placed', async () => {
    const player = await fundedPlayer(app, '0');
    const funded = await admin.post('/wallet/manual-adjustments', {
      userId: player.userId,
      direction: 'credit',
      amount: '200',
      currency: 'USD',
      reason: 'sportsbook attack funds',
      idempotencyKey: randomUUID(),
    });
    expect(funded.status).toBe(200);
    const early = await acceptedBet(app, player, { stake: '50', potentialPayout: '200' });
    await deposit(player.client, '100');

    await settle(early.args.providerBetId, 'lost', '0');

    expectMoney(await progressOf(player.client), '0', 'progress after the early stake settles');
    const late = await acceptedBet(app, player, { stake: '50', potentialPayout: '200' });
    await settle(late.args.providerBetId, 'lost', '0');
    expectMoney(await progressOf(player.client), '50', 'progress after a stake placed while owing');
  });

  it('keeps a withdrawal refused while the only wagering is an unsettled stake', async () => {
    const player = await fundedPlayer(app, '100');
    const open = await acceptedBet(app, player, { stake: '60', potentialPayout: '200' });

    const refused = await player.client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '5',
      currency: 'USD',
    });

    expect(refused.status).toBe(409);
    expect(await readJson(refused)).toMatchObject({
      data: { reason: 'turnover_requirement_unmet' },
    });
    await settle(open.args.providerBetId, 'lost', '0');
    expectMoney(await progressOf(player.client), '60', 'progress after settle');
  });
});
