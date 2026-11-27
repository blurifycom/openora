import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { DRIZZLE, moneyAdd, moneyEquals } from '@openora/core/server';
import { AuditLogEntrySchema } from '@openora/core/audit/contract';
import { paginated } from '@openora/core/contracts/kit';
import { RakebackClaimResultSchema } from '@openora/core/promo/contracts/gamification';
import {
  promoRakebackAccrual,
  promoRakebackClaim,
  promoRakebackClaimPayout,
  promoRankPeriodicReward,
} from '@openora/core/promo/schema/gamification';
import { wallet, walletBalance } from '@openora/core/wallet/schema';
import {
  asAdmin,
  bootE2e,
  closeE2e,
  flushAudit,
  newPlayer,
  readJson,
  type E2e,
  type NamedAccount,
  type TestClient,
} from '../index.js';

const RAKEBACK = '2.5';
const REWARD = '3';
const LogPageSchema = paginated(AuditLogEntrySchema);

let e2e: E2e;
let admin: TestClient;

beforeAll(async () => {
  e2e = await bootE2e();
  admin = await asAdmin(e2e.app.app);
}, 60_000);

afterAll(() => closeE2e(e2e));

const db = () => e2e.app.container.get(DRIZZLE).db;

async function auditLogs(q: string, action: string) {
  await flushAudit(e2e.app);
  const res = await admin.get(`/audit/logs?${new URLSearchParams({ limit: '100', q, action })}`);
  expect(res.status).toBe(200);
  return LogPageSchema.parse(await readJson(res)).items;
}

/** For an entry written by a job that runs after the request returned. */
const eventually = (q: string, action: string) =>
  vi.waitFor(
    async () => {
      const rows = await auditLogs(q, action);
      expect(rows.length).toBeGreaterThan(0);
      return rows;
    },
    { timeout: 10_000, interval: 100 },
  );

/** Read from the ledger, not the API: a self-excluded player's session is gone. */
async function usdBalance(player: NamedAccount): Promise<string> {
  const [row] = await db()
    .select({ amount: walletBalance.amount })
    .from(walletBalance)
    .innerJoin(wallet, eq(wallet.id, walletBalance.walletId))
    .where(and(eq(wallet.userId, player.userId), eq(walletBalance.currency, 'USD')));
  return row?.amount ?? '0';
}

const creditedOnce = async (player: NamedAccount, before: string, amount: string) =>
  moneyEquals(await usdBalance(player), moneyAdd(before, amount));

async function playerWithRakeback(prefix: string): Promise<NamedAccount> {
  const player = await newPlayer(e2e.app, prefix);
  await db().insert(promoRakebackAccrual).values({
    userId: player.userId,
    currency: 'USD',
    amount: RAKEBACK,
    stake: '50',
    basis: 'stake',
    ratePercent: '5',
    boostPercent: '0',
  });
  return player;
}

async function claimableReward(player: NamedAccount): Promise<string> {
  const now = new Date();
  const [reward] = await db()
    .insert(promoRankPeriodicReward)
    .values({
      userId: player.userId,
      kind: 'daily',
      periodKey: now.toISOString().slice(0, 10),
      periodStart: new Date(now.getTime() - 86_400_000),
      periodEnd: now,
      tierId: randomUUID(),
      ladderCurrency: 'USD',
      ladderAmount: REWARD,
      currency: 'USD',
      amount: REWARD,
    })
    .returning({ id: promoRankPeriodicReward.id });
  if (!reward) {
    throw new Error('rank reward insert returned no row');
  }
  return reward.id;
}

const claimRakeback = (player: NamedAccount, idempotencyKey = randomUUID()) =>
  player.client.post('/promo/rakeback/claim', { idempotencyKey });

const claimReward = (player: NamedAccount, rewardId: string) =>
  player.client.post(`/promo/ranks/rewards/${rewardId}/claim`, { idempotencyKey: randomUUID() });

const payoutsOf = (player: NamedAccount) =>
  db()
    .select()
    .from(promoRakebackClaimPayout)
    .where(eq(promoRakebackClaimPayout.userId, player.userId));

const selfExclude = async (player: NamedAccount) => {
  const res = await player.client.post('/compliance/rg/self-exclusion', {
    isPermanent: true,
    confirm: true,
  });
  expect(res.status).toBe(200);
};

describe('rakeback claim audit', () => {
  it('records the player id as actor, so a search by player id finds the claim', async () => {
    const player = await playerWithRakeback('rb-actor');

    const res = await claimRakeback(player);

    expect(res.status).toBe(200);
    const { claimId } = RakebackClaimResultSchema.parse(await readJson(res));
    const rows = await auditLogs(player.playerId, 'promo.rakeback.claimed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: player.playerId,
      actorType: 'player',
      resourceType: 'promo_rakeback_claim',
      resourceId: claimId,
      after: expect.objectContaining({ userId: player.userId }),
    });
  });

  it('a double submit with one key pays, credits and audits once', async () => {
    const player = await playerWithRakeback('rb-double');
    const before = await usdBalance(player);
    const key = randomUUID();

    const [first, second] = await Promise.all([
      claimRakeback(player, key),
      claimRakeback(player, key),
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    const ids = [
      RakebackClaimResultSchema.parse(await readJson(first)),
      RakebackClaimResultSchema.parse(await readJson(second)),
    ];
    expect(ids[1]?.claimId).toBe(ids[0]?.claimId);
    expect(await payoutsOf(player)).toHaveLength(1);
    expect(await creditedOnce(player, before, RAKEBACK)).toBe(true);
    expect(await auditLogs(player.playerId, 'promo.rakeback.claimed')).toHaveLength(1);
  });

  it('a failed audit write rolls the claim back; a retry with the same key pays once', async () => {
    const player = await playerWithRakeback('rb-atomic');
    const before = await usdBalance(player);
    const key = randomUUID();
    // Fault injection on the real database: this player's claim audit record cannot be queued.
    await db().execute(sql`
      CREATE FUNCTION rb_audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'audit write refused'; END $$`);
    try {
      await db().execute(
        sql.raw(`
        CREATE TRIGGER rb_audit_fail BEFORE INSERT ON audit_outbox
        FOR EACH ROW WHEN (NEW.entry->>'action' = 'promo.rakeback.claimed'
          AND NEW.entry->'after'->>'userId' = '${player.userId}')
        EXECUTE FUNCTION rb_audit_fail()`),
      );
      const failed = await claimRakeback(player, key);

      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(JSON.stringify(await readJson(failed))).not.toContain(player.userId);
      expect(await usdBalance(player)).toBe(before);
      expect(await payoutsOf(player)).toEqual([]);
      const accruals = await db()
        .select({ status: promoRakebackAccrual.status })
        .from(promoRakebackAccrual)
        .where(eq(promoRakebackAccrual.userId, player.userId));
      expect(accruals.map((row) => row.status)).toEqual(['accrued']);
      const claims = await db()
        .select()
        .from(promoRakebackClaim)
        .where(eq(promoRakebackClaim.userId, player.userId));
      expect(claims).toEqual([]);
    } finally {
      await db().execute(sql`DROP TRIGGER IF EXISTS rb_audit_fail ON audit_outbox`);
      await db().execute(sql`DROP FUNCTION IF EXISTS rb_audit_fail()`);
    }

    expect((await claimRakeback(player, key)).status).toBe(200);
    expect(await payoutsOf(player)).toHaveLength(1);
    expect(await creditedOnce(player, before, RAKEBACK)).toBe(true);
    const rows = await auditLogs(player.playerId, 'promo.rakeback.claimed');
    expect(rows.map((row) => row.actorId)).toEqual([player.playerId]);
  });

  it('an auto-payout after a self-exclusion is a system entry with no actor, credited once', async () => {
    const player = await playerWithRakeback('rb-auto');
    const before = await usdBalance(player);

    await selfExclude(player);

    const rows = await eventually(player.userId, 'promo.rakeback.auto_paid');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: 'system',
      actorId: null,
      resourceType: 'promo_rakeback_claim',
    });
    expect(await payoutsOf(player)).toHaveLength(1);
    expect(await creditedOnce(player, before, RAKEBACK)).toBe(true);
    expect(await auditLogs(player.userId, 'promo.rakeback.claimed')).toEqual([]);
  });
});

describe('rank reward claim audit', () => {
  it('records the player id as actor, so a search by player id finds the claim', async () => {
    const player = await newPlayer(e2e.app, 'rr-actor');
    const rewardId = await claimableReward(player);

    expect((await claimReward(player, rewardId)).status).toBe(200);

    const rows = await auditLogs(player.playerId, 'promo.rank_reward.claimed');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorId: player.playerId,
      actorType: 'player',
      resourceType: 'promo_rank_periodic_reward',
      resourceId: rewardId,
      after: expect.objectContaining({ userId: player.userId }),
    });
  });

  it("another player's claim is refused: no credit, reward still claimable, no audit entry", async () => {
    const owner = await newPlayer(e2e.app, 'rr-owner');
    const thief = await newPlayer(e2e.app, 'rr-thief');
    const rewardId = await claimableReward(owner);
    const before = await usdBalance(thief);

    expect((await claimReward(thief, rewardId)).status).toBe(404);

    expect(await usdBalance(thief)).toBe(before);
    const [reward] = await db()
      .select({ status: promoRankPeriodicReward.status })
      .from(promoRankPeriodicReward)
      .where(eq(promoRankPeriodicReward.id, rewardId));
    expect(reward?.status).toBe('claimable');
    expect(await auditLogs(rewardId, 'promo.rank_reward.claimed')).toEqual([]);
  });

  it('an auto-payout after a self-exclusion is a system entry with no actor, credited once', async () => {
    const player = await newPlayer(e2e.app, 'rr-auto');
    const rewardId = await claimableReward(player);
    const before = await usdBalance(player);

    await selfExclude(player);

    const rows = await eventually(rewardId, 'promo.rank_reward.auto_paid');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'system', actorId: null });
    expect(await creditedOnce(player, before, REWARD)).toBe(true);
    expect(await auditLogs(rewardId, 'promo.rank_reward.claimed')).toEqual([]);
  });
});

it.each(['/promo/rakeback/claim', `/promo/ranks/rewards/${randomUUID()}/claim`])(
  'POST %s without a session is refused',
  async (path) => {
    const res = await e2e.app.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: randomUUID() }),
    });
    expect(res.status).toBe(401);
  },
);
