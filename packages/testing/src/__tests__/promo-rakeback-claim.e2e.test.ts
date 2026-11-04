import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { and, eq, like, sql } from 'drizzle-orm';
import { loadExtensions, DRIZZLE, EVENT_BUS } from '@openora/core/server';
import { WAGER_TRACKING } from '@openora/core/contracts';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { rgExclusion } from '@openora/core/compliance/schema';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';

const JOB_WAIT = { timeout: 15000, interval: 100 };

let db: TestDb;
let app: TestApp;
let admin: TestClient;

const drizzle = () => app.container.get(DRIZZLE).db;

const newPlayer = () =>
  registerAndMaterializePlayer(app, { email: `rakeback-${randomUUID()}@example.test` });

const bet = (userId: string, amount: string, roundId = randomUUID()) =>
  drizzle().transaction((tx) =>
    app.container.get(WAGER_TRACKING).recordWager(tx, {
      userId,
      currency: 'USDT',
      amount,
      weightedAmount: amount,
      realAmount: amount,
      context: { provider: 'aggregator', product: 'casino', rtp: '0.96', gameId: 'slot-1' },
      round: { providerName: 'aggregator', externalRoundId: roundId },
    }),
  );

const rollBack = (userId: string, roundId: string, realAmount: string) =>
  drizzle().transaction(async (tx) => {
    await app.container.get(WAGER_TRACKING).reverseWager?.(tx, {
      userId,
      currency: 'USDT',
      round: { providerName: 'aggregator', externalRoundId: roundId },
      realAmount,
    });
  });

const claimCredits = (claimId: string) =>
  drizzle()
    .select({ amount: walletTransaction.amount, type: walletTransaction.type })
    .from(walletTransaction)
    .where(like(walletTransaction.providerRefId, `${claimId}:%`));

const selfExclusionActivated = (userId: string) =>
  app.container.get(EVENT_BUS).emit('rg.self_exclusion.activated', {
    userId,
    playerId: null,
    exclusionId: randomUUID(),
    isPermanent: true,
    durationMonths: null,
    expiresAt: null,
    initiatedBy: 'system',
    actorId: randomUUID(),
    reason: 'rg rule triggered',
  });

const accrualsOf = async (userId: string) =>
  (await readJson(await admin.get(`/backoffice/promo/rakeback/accruals?userId=${userId}`))).items;

const claim = (client: TestClient, idempotencyKey: string = randomUUID()) =>
  client.post('/promo/rakeback/claim', { idempotencyKey });

beforeAll(async () => {
  ({ db, app } = await bootE2e({
    plugins: [
      ...(await loadExtensions()),
      {
        id: 'testing-rakeback-claim-config',
        path: fileURLToPath(
          new URL('./fixtures/test-rakeback-claim-config-plugin.ts', import.meta.url),
        ),
      },
    ],
  }));
  admin = await asAdmin(app.app);
}, 60_000);

afterAll(async () => {
  await closeE2e({ app, db });
});

describe('a player claiming rakeback on the house edge', () => {
  it('accrues on the bet, pays it on claim, and replays a retry without paying again', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '1000');

    const summary = await readJson(await client.get('/promo/rakeback'));
    expect(summary).toMatchObject({
      unclaimed: [{ currency: 'USDT', amount: '0.400000000000000000' }],
      referenceTotal: '0.400000000000000000',
      claimMinimum: '0.10',
      claimBlockedBy: null,
    });

    const key = randomUUID();
    const res = await claim(client, key);
    const body = await readJson(res);
    expect(res.status).toBe(200);
    expect(body.paid).toEqual([{ currency: 'USDT', amount: '0.400000000000000000' }]);
    expect(await claimCredits(body.claimId)).toEqual([
      { amount: '0.400000000000000000', type: 'cashback' },
    ]);
    const audit = await readJson(
      await admin.get(`/audit/logs?resourceId=${body.claimId}&action=promo.rakeback.claimed`),
    );
    expect(audit.items).toEqual([
      expect.objectContaining({ actorType: 'player', actorId: userId }),
    ]);

    const retry = await claim(client, key);
    expect(retry.status).toBe(200);
    expect((await readJson(retry)).claimId).toBe(body.claimId);
    expect(await claimCredits(body.claimId)).toHaveLength(1);
    expect((await readJson(await client.get('/promo/rakeback'))).lifetimeClaimed).toEqual([
      { currency: 'USDT', amount: '0.400000000000000000' },
    ]);
  });

  it('pays each accrual once when two claims race', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '1000');
    await bet(userId, '500');

    const responses = await Promise.all([claim(client), claim(client)]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await readJson(responses.find((r) => r.status === 200)!);
    expect(await claimCredits(winner.claimId)).toEqual([
      expect.objectContaining({ amount: '0.600000000000000000' }),
    ]);
    const accruals = await accrualsOf(userId);
    expect(accruals.every((row: { claimId: string }) => row.claimId === winner.claimId)).toBe(true);
  });

  it('refuses a claim below the minimum', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '100');

    const res = await claim(client);

    expect(res.status).toBe(409);
    expect((await readJson(res)).data).toEqual({ reason: 'below_minimum' });
  });

  it('takes a rolled-back round off the unclaimed balance, but never off a paid claim', async () => {
    const { client, userId } = await newPlayer();
    const reversedRound = randomUUID();
    const paidRound = randomUUID();
    await bet(userId, '1000', paidRound);
    await claim(client);
    await bet(userId, '5000', reversedRound);

    await rollBack(userId, reversedRound, '5000');
    await rollBack(userId, paidRound, '1000');

    const summary = await readJson(await client.get('/promo/rakeback'));
    expect(summary.unclaimed).toEqual([]);
    expect(summary.lifetimeClaimed).toEqual([{ currency: 'USDT', amount: '0.400000000000000000' }]);
  });

  it('is refused for a player under a responsible-gambling block', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '1000');
    await drizzle().update(user).set({ rgBlocked: true }).where(eq(user.id, userId));

    const res = await claim(client);

    expect(res.status).toBe(403);
    expect((await readJson(res)).data).toEqual({ reason: 'restricted' });
    expect((await readJson(await client.get('/promo/rakeback'))).claimBlockedBy).toBe('restricted');
    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
  });

  it('throttles repeated claim attempts', async () => {
    const { client } = await newPlayer();
    let lastStatus = 0;
    for (let attempt = 0; attempt < 10 && lastStatus !== 429; attempt += 1) {
      lastStatus = (await claim(client)).status;
    }

    expect(lastStatus).toBe(429);
  });

  it('is refused outright when signed out', async () => {
    const res = await app.app.request('/promo/rakeback');

    expect(res.status).toBe(401);
  });
});

describe('the claim id on a wallet transaction', () => {
  it('is shown to an admin and kept off the player history', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '1000');
    const { claimId } = await readJson(await claim(client));

    const own = await readJson(await client.get('/wallet/transactions?currency=USDT'));
    const adminView = await readJson(
      await admin.get(`/wallet/transactions/${userId}?currency=USDT`),
    );

    const ownCashback = own.items.find((tx: { type: string }) => tx.type === 'cashback');
    const adminCashback = adminView.items.find((tx: { type: string }) => tx.type === 'cashback');
    expect(ownCashback).toBeDefined();
    expect(ownCashback).not.toHaveProperty('claimId');
    expect(adminCashback.claimId).toBe(claimId);
    expect(adminView.items.every((tx: object) => !('metadata' in tx))).toBe(true);
  });
});

describe('an admin voiding unclaimed rakeback', () => {
  it('is refused to a player', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '1000');
    const [accrual] = await accrualsOf(userId);

    const res = await client.post(`/backoffice/promo/rakeback/accruals/${accrual.id}/void`, {
      reason: 'self-service',
    });

    expect(res.status).toBe(403);
    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
  });

  it('needs a reason', async () => {
    const { userId } = await newPlayer();
    await bet(userId, '1000');
    const [accrual] = await accrualsOf(userId);

    const res = await admin.post(`/backoffice/promo/rakeback/accruals/${accrual.id}/void`, {
      reason: '  ',
    });

    expect(res.status).toBe(400);
  });

  it('voids with a reason, records an audit entry, and refuses a second void', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '1000');
    const [accrual] = await accrualsOf(userId);

    const res = await admin.post(`/backoffice/promo/rakeback/accruals/${accrual.id}/void`, {
      reason: 'duplicate round',
    });
    const again = await admin.post(`/backoffice/promo/rakeback/accruals/${accrual.id}/void`, {
      reason: 'duplicate round',
    });

    expect(res.status).toBe(200);
    expect(await readJson(res)).toMatchObject({ status: 'voided', voidReason: 'duplicate round' });
    expect(again.status).toBe(409);
    const audit = await readJson(
      await admin.get(`/audit/logs?resourceId=${accrual.id}&action=promo.rakeback.voided`),
    );
    expect(audit.items).toEqual([expect.objectContaining({ actorType: 'admin' })]);
    expect((await readJson(await client.get('/promo/rakeback'))).unclaimed).toEqual([]);
  });

  it('shows the operator liability and a player breakdown', async () => {
    const { userId } = await newPlayer();
    await bet(userId, '1000');

    const liability = await admin.get('/backoffice/promo/rakeback/liability');
    const breakdown = await readJson(
      await admin.get(`/backoffice/promo/rakeback/players/${userId}`),
    );

    expect(liability.status).toBe(200);
    expect(breakdown).toMatchObject({
      userId,
      unclaimed: [{ currency: 'USDT', amount: '0.400000000000000000' }],
    });
  });
});

describe('rakeback auto-payout on self-exclusion', () => {
  it('pays nothing when the player is no longer self-excluded as the job runs', async () => {
    const { userId } = await newPlayer();
    await bet(userId, '100');

    selfExclusionActivated(userId);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
  });

  it('serializes a stale auto-payout with a concurrent exclusion lift', async () => {
    const { client, userId } = await newPlayer();
    await bet(userId, '100');
    const [exclusion] = await drizzle()
      .insert(rgExclusion)
      .values({
        userId,
        kind: 'self_exclusion',
        status: 'active',
        isPermanent: false,
        startsAt: new Date('2020-01-01'),
        expiresAt: new Date('2020-07-01'),
        reason: 'elapsed exclusion',
        createdBy: userId,
      })
      .returning();
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = drizzle().transaction(async (tx) => {
      await tx.select().from(rgExclusion).where(eq(rgExclusion.id, exclusion!.id)).for('update');
      locked();
      await gate;
    });
    await ready;
    const lift = admin.post(`/compliance/players/${userId}/self-exclusion/lift`, {
      reason: 'minimum period elapsed',
      confirm: true,
    });
    const waitingQueries = async () => {
      const result = await drizzle().execute<{ query: string }>(sql`
        select query from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and query like '%rg_exclusion%'
      `);
      return result.rows.map((row) => row.query);
    };
    try {
      await vi.waitFor(async () => {
        expect((await waitingQueries()).some((query) => query.startsWith('update'))).toBe(true);
      }, JOB_WAIT);
      selfExclusionActivated(userId);
      await vi.waitFor(async () => {
        const blocked = (await waitingQueries()).some((query) => query.includes('for share'));
        const paid = (await accrualsOf(userId)).some(
          (row: { status: string }) => row.status === 'claimed',
        );
        expect(blocked || paid).toBe(true);
      }, JOB_WAIT);
      expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
    } finally {
      release();
      await holder;
    }
    const response = await lift;
    expect(response.status).toBe(200);
    expect(await readJson(response)).toMatchObject({ id: exclusion!.id, status: 'lifted' });
    const [stored] = await drizzle()
      .select()
      .from(rgExclusion)
      .where(eq(rgExclusion.id, exclusion!.id));
    expect(stored?.status).toBe('lifted');
    await vi.waitFor(async () => {
      expect((await waitingQueries()).some((query) => query.includes('for share'))).toBe(false);
    }, JOB_WAIT);
    expect(
      await drizzle()
        .select()
        .from(walletTransaction)
        .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
        .where(and(eq(wallet.userId, userId), eq(walletTransaction.type, 'cashback'))),
    ).toEqual([]);
    expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'accrued' })]);
    const summary = await readJson(await client.get('/promo/rakeback'));
    expect(summary.lifetimeClaimed).toEqual([]);
    expect(summary.unclaimed).toEqual([
      { currency: 'USDT', amount: '0.040000000000000000', referenceAmount: '0.040000000000000000' },
    ]);
  });

  it('pays out below the minimum, once', async () => {
    const { userId } = await newPlayer();
    await bet(userId, '100');

    await drizzle()
      .update(player)
      .set({ status: 'self_excluded' })
      .where(eq(player.userId, userId));
    selfExclusionActivated(userId);
    await vi.waitFor(async () => {
      expect(await accrualsOf(userId)).toEqual([expect.objectContaining({ status: 'claimed' })]);
    }, JOB_WAIT);
    const [paid] = await accrualsOf(userId);
    selfExclusionActivated(userId);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    expect(await claimCredits(paid.claimId)).toEqual([
      { amount: '0.040000000000000000', type: 'cashback' },
    ]);
  });
});
