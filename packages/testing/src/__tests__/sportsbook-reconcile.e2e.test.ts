import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TransactionRollbackError, and, asc, eq, sql } from 'drizzle-orm';
import { auditLog } from '@openora/core/audit/schema';
import { rgFlag } from '@openora/core/compliance/schema';
import { JOB_QUEUE } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { betting } from '@openora/core/sportsbook/contracts';
import {
  sportsbookBet,
  sportsbookBetTransaction,
  sportsbookReconciliationFinding,
  sportsbookSession,
} from '@openora/core/sportsbook/schema/betting';
import { closeE2e, type TestApp, type TestClient, type TestDb } from '../index.js';
import { mockSportsbookProviderState } from '../test-sportsbook-provider-plugin.js';
import {
  PROVIDER,
  acceptedBet,
  balanceOf,
  bootSportsbookApp,
  deposit,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  reserveArgs,
  txId,
  type SportsbookPlayer,
} from './fixtures/sportsbook.js';

let db: TestDb;
let app: TestApp;
let admin: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp());
  admin = await enableSportsbook(app);
}, 60_000);

afterAll(() => closeE2e({ app, db }));

beforeEach(() => mockSportsbookProviderState.reset());

const drizzle = () => app.container.get(DRIZZLE).db;

async function betRow(betId: string) {
  const [row] = await drizzle().select().from(sportsbookBet).where(eq(sportsbookBet.id, betId));
  return row!;
}

const findingKinds = async (betId: string) =>
  (
    await drizzle()
      .select({ kind: sportsbookReconciliationFinding.kind })
      .from(sportsbookReconciliationFinding)
      .where(eq(sportsbookReconciliationFinding.betId, betId))
  ).map((f) => f.kind);

async function staleReserve(player: SportsbookPlayer) {
  const args = reserveArgs(player.sessionId);
  const { betId } = expectApplied(await ledgerOf(app).reserve(args));
  await drizzle()
    .update(sportsbookBet)
    .set({ createdAt: new Date(Date.now() - 3_600_000) })
    .where(eq(sportsbookBet.id, betId!));
  return { args, betId: betId! };
}

async function revokedAt(sessionId: string) {
  const [session] = await drizzle()
    .select({ revokedAt: sportsbookSession.revokedAt })
    .from(sportsbookSession)
    .where(eq(sportsbookSession.id, sessionId));
  return session?.revokedAt ?? null;
}

async function failFirstSessionUpdate(userId: string) {
  const name = `sb_fault_${userId.replaceAll('-', '')}`;
  await drizzle().execute(
    sql.raw(`
      create sequence ${name};
      create function ${name}() returns trigger language plpgsql as $$
      begin
        if new.user_id = '${userId}' then
          if nextval('${name}') = 1 then
            raise exception 'injected sportsbook session fault';
          end if;
        end if;
        return new;
      end $$;
      create trigger ${name} before update on sportsbook_session
        for each row execute function ${name}();
    `),
  );
  return async () => {
    await drizzle().execute(
      sql.raw(
        `drop trigger ${name} on sportsbook_session; drop function ${name}(); drop sequence ${name};`,
      ),
    );
  };
}

const lossFlagStatus = async (userId: string) =>
  (
    await drizzle()
      .select({ status: rgFlag.status })
      .from(rgFlag)
      .where(
        and(
          eq(rgFlag.userId, userId),
          eq(rgFlag.flagType, 'limit_threshold'),
          eq(rgFlag.limitType, 'loss'),
        ),
      )
  ).map((f) => f.status);

const reconcilePass = () =>
  app.container.get(JOB_QUEUE).enqueue(betting.SPORTSBOOK_RECONCILE_QUEUE, {});

describe('sportsbook reconciliation', () => {
  it('settles a stale reserve the provider reports as won', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await staleReserve(player);
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '25',
    });

    await reconcilePass();
    await vi.waitFor(async () => expect((await betRow(betId)).status).toBe('settled'), {
      timeout: 15_000,
    });
    expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
    const txIds = (
      await drizzle()
        .select({ providerTxId: sportsbookBetTransaction.providerTxId })
        .from(sportsbookBetTransaction)
        .where(eq(sportsbookBetTransaction.betId, betId))
    ).map((t) => t.providerTxId);
    expect(txIds).toEqual(
      expect.arrayContaining([`core-align:${betId}:v1:confirm`, `core-align:${betId}:v1:settle`]),
    );
  });

  it('refunds a stale reserve the provider never accepted', async () => {
    const player = await fundedPlayer(app, '100');
    const { betId } = await staleReserve(player);

    await reconcilePass();
    await vi.waitFor(async () => expect((await betRow(betId)).status).toBe('cancelled'), {
      timeout: 15_000,
    });
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
  });

  it('files a reserve it cannot resolve after the last attempt and stops visiting it', async () => {
    const player = await fundedPlayer(app, '100');
    const { betId } = await staleReserve(player);
    mockSportsbookProviderState.failLookup = true;

    for (let attempt = 1; attempt <= betting.SPORTSBOOK_RECONCILE_MAX_ATTEMPTS; attempt++) {
      await reconcilePass();
      await vi.waitFor(
        async () => expect((await betRow(betId)).reconcileAttempts).toBeGreaterThanOrEqual(attempt),
        { timeout: 15_000 },
      );
    }
    expect(await findingKinds(betId)).toEqual(['reserve_unresolved']);

    mockSportsbookProviderState.failLookup = false;
    const control = await staleReserve(player);
    await reconcilePass();
    await vi.waitFor(async () => expect((await betRow(control.betId)).status).toBe('cancelled'), {
      timeout: 15_000,
    });
    expect(await betRow(betId)).toMatchObject({
      status: 'reserved',
      reconcileAttempts: betting.SPORTSBOOK_RECONCILE_MAX_ATTEMPTS,
    });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
  });

  it('files nothing when the provider confirms the bet while reconciliation looks it up', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await staleReserve(player);
    mockSportsbookProviderState.statuses.set(args.providerBetId, { status: 'accepted' });
    mockSportsbookProviderState.onLookup = async () => {
      expectApplied(
        await ledgerOf(app).confirm({
          provider: PROVIDER,
          providerTxId: txId(),
          providerBetId: args.providerBetId,
        }),
      );
    };

    await reconcilePass();
    await vi.waitFor(
      async () => expect(mockSportsbookProviderState.lookups).toContain(args.providerBetId),
      { timeout: 15_000 },
    );
    const control = await staleReserve(player);
    mockSportsbookProviderState.onLookup = null;
    await reconcilePass();
    await vi.waitFor(async () => expect((await betRow(control.betId)).status).toBe('cancelled'), {
      timeout: 15_000,
    });
    expect((await betRow(betId)).status).toBe('accepted');
    expect(await findingKinds(betId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
  });

  it('reverses nothing when the bet settles while reconciliation looks it up', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await staleReserve(player);
    mockSportsbookProviderState.statuses.set(args.providerBetId, { status: 'accepted' });
    mockSportsbookProviderState.onLookup = async () => {
      const key = { provider: PROVIDER, providerBetId: args.providerBetId };
      expectApplied(await ledgerOf(app).confirm({ ...key, providerTxId: txId() }));
      expectApplied(
        await ledgerOf(app).settle({ ...key, providerTxId: txId(), result: 'won', payout: '25' }),
      );
    };

    await reconcilePass();
    await vi.waitFor(async () => expect((await betRow(betId)).status).toBe('settled'), {
      timeout: 15_000,
    });
    const control = await staleReserve(player);
    mockSportsbookProviderState.onLookup = null;
    await reconcilePass();
    await vi.waitFor(async () => expect((await betRow(control.betId)).status).toBe('cancelled'), {
      timeout: 15_000,
    });
    expect(await betRow(betId)).toMatchObject({ status: 'settled', version: 1, result: 'won' });
    expect(await findingKinds(betId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
  });

  it('leaves a reserve the provider still holds as pending and spends an attempt', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await staleReserve(player);
    mockSportsbookProviderState.statuses.set(args.providerBetId, { status: 'pending' });

    await reconcilePass();
    await vi.waitFor(
      async () => expect((await betRow(betId)).reconcileAttempts).toBeGreaterThanOrEqual(1),
      { timeout: 15_000 },
    );
    expect((await betRow(betId)).status).toBe('reserved');
  });

  it('files an accepted bet still open well after its last event, once per version', async () => {
    const player = await fundedPlayer(app, '100');
    const { betId } = await acceptedBet(app, player);
    await drizzle()
      .update(sportsbookBet)
      .set({ lastLegStartsAt: new Date(Date.now() - 3_600_000) })
      .where(eq(sportsbookBet.id, betId));

    await reconcilePass();
    await vi.waitFor(
      async () => expect(await findingKinds(betId)).toEqual(['settlement_overdue']),
      {
        timeout: 15_000,
      },
    );
    const control = await fundedPlayer(app, '100');
    const controlBet = await staleReserve(control);
    await reconcilePass();
    await vi.waitFor(
      async () => expect((await betRow(controlBet.betId)).status).toBe('cancelled'),
      { timeout: 15_000 },
    );
    expect(await findingKinds(betId)).toEqual(['settlement_overdue']);
    expect((await betRow(betId)).status).toBe('accepted');
  });
});

describe('sportsbook align of a corrected settlement', () => {
  it('answers 409 and applies nothing when a settlement lands while the provider is asked', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    mockSportsbookProviderState.statuses.set(args.providerBetId, { status: 'accepted' });
    mockSportsbookProviderState.onLookup = async () => {
      expectApplied(
        await ledgerOf(app).settle({
          provider: PROVIDER,
          providerTxId: txId(),
          providerBetId: args.providerBetId,
          result: 'won',
          payout: '25',
        }),
      );
    };

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(res.status).toBe(409);
    expect(((await res.json()) as { data?: unknown }).data).toEqual({ reason: 'bet_changed' });
    expect(await betRow(betId)).toMatchObject({ status: 'settled', version: 1, result: 'won' });
    expect(await findingKinds(betId)).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe('115.000000000000000000');
  });

  it('reopens and settles again at the next version when the provider corrected the result', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '25',
      }),
    );
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'lost',
      payout: '0',
    });

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ applied: ['reopen', 'settle'] });
    expect(await betRow(betId)).toMatchObject({ status: 'settled', version: 2, result: 'lost' });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');

    const again = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`, {});
    expect(await again.json()).toMatchObject({ applied: [] });
    expect(await balanceOf(app, player.userId)).toBe('90.000000000000000000');
  });
});

describe('responsible gambling ends sportsbook play', () => {
  it.each([
    { kind: 'cooling-off', path: '/compliance/rg/cooling-off', body: { durationHours: 24 } },
    {
      kind: 'self-exclusion',
      path: '/compliance/rg/self-exclusion',
      body: { isPermanent: true, confirm: true },
    },
  ])('revokes every live session on $kind, at core and at the provider', async ({ path, body }) => {
    const player = await fundedPlayer(app, '100');
    const res = await player.client.post(path, body);
    expect(res.status).toBe(200);

    await vi.waitFor(
      async () => {
        expect(await revokedAt(player.sessionId)).not.toBeNull();
        expect(mockSportsbookProviderState.revoked).toContain(player.sessionId);
      },
      { timeout: 15_000 },
    );
    expect(await ledgerOf(app).reserve(reserveArgs(player.sessionId))).toEqual({
      status: 'refused',
      reason: 'session_invalid',
    });
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
    const audited = await drizzle()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'sportsbook.sessions.revoked'),
          eq(auditLog.resourceId, player.userId),
        ),
      );
    expect(audited).toHaveLength(1);
    expect(audited[0]).toMatchObject({
      actorType: 'system',
      after: { revokedSessions: [player.sessionId] },
    });
  });

  it('still revokes the sessions when the first revoke attempt fails', async () => {
    const player = await fundedPlayer(app, '100');
    const restore = await failFirstSessionUpdate(player.userId);
    try {
      const res = await player.client.post('/compliance/rg/cooling-off', { durationHours: 24 });
      expect(res.status).toBe(200);
      await vi.waitFor(
        async () => {
          expect(await revokedAt(player.sessionId)).not.toBeNull();
          expect(mockSportsbookProviderState.revoked).toContain(player.sessionId);
        },
        { timeout: 15_000 },
      );
    } finally {
      await restore();
    }
  });

  it('retries until the provider acknowledges the revoke', async () => {
    const player = await fundedPlayer(app, '100');
    mockSportsbookProviderState.failRevokes = 1;
    const res = await player.client.post('/compliance/rg/cooling-off', { durationHours: 24 });
    expect(res.status).toBe(200);

    await vi.waitFor(
      async () => {
        const [session] = await drizzle()
          .select({ providerRevokedAt: sportsbookSession.providerRevokedAt })
          .from(sportsbookSession)
          .where(eq(sportsbookSession.id, player.sessionId));
        expect(session?.providerRevokedAt).not.toBeNull();
      },
      { timeout: 15_000 },
    );
    expect(mockSportsbookProviderState.failRevokes).toBe(0);
    expect(mockSportsbookProviderState.revoked).toContain(player.sessionId);
  });

  it('retries an unacknowledged provider revoke from the reconcile pass', async () => {
    const player = await fundedPlayer(app, '100');
    await drizzle()
      .update(sportsbookSession)
      .set({ revokedAt: new Date() })
      .where(eq(sportsbookSession.id, player.sessionId));

    await reconcilePass();
    await vi.waitFor(
      async () => {
        const [session] = await drizzle()
          .select({ providerRevokedAt: sportsbookSession.providerRevokedAt })
          .from(sportsbookSession)
          .where(eq(sportsbookSession.id, player.sessionId));
        expect(session?.providerRevokedAt).not.toBeNull();
      },
      { timeout: 15_000 },
    );
    expect(mockSportsbookProviderState.revoked).toContain(player.sessionId);
  });

  const providerRevokeOf = async (sessionId: string) => {
    const [row] = await drizzle()
      .select({
        revokedAt: sportsbookSession.providerRevokedAt,
        attemptedAt: sportsbookSession.providerRevokeAttemptedAt,
      })
      .from(sportsbookSession)
      .where(eq(sportsbookSession.id, sessionId));
    return row!;
  };

  it('keeps a revoke pending for a session whose provider open core never recorded', async () => {
    const player = await fundedPlayer(app, '100');
    await drizzle()
      .update(sportsbookSession)
      .set({ revokedAt: new Date(), providerOpenedAt: null })
      .where(eq(sportsbookSession.id, player.sessionId));

    await reconcilePass();
    await vi.waitFor(
      () => expect(mockSportsbookProviderState.revoked).toContain(player.sessionId),
      {
        timeout: 15_000,
      },
    );
    await vi.waitFor(
      async () => expect((await providerRevokeOf(player.sessionId)).attemptedAt).not.toBeNull(),
      { timeout: 15_000 },
    );
    expect((await providerRevokeOf(player.sessionId)).revokedAt).toBeNull();
  });

  it('records a failed provider revoke so the next pass tries other sessions first', async () => {
    const player = await fundedPlayer(app, '100');
    await drizzle()
      .update(sportsbookSession)
      .set({ revokedAt: new Date() })
      .where(eq(sportsbookSession.id, player.sessionId));
    mockSportsbookProviderState.failRevokes = Number.MAX_SAFE_INTEGER;

    await reconcilePass();
    await vi.waitFor(
      async () => expect((await providerRevokeOf(player.sessionId)).attemptedAt).not.toBeNull(),
      { timeout: 15_000 },
    );
    mockSportsbookProviderState.failRevokes = 0;

    await reconcilePass();
    await vi.waitFor(
      async () => expect((await providerRevokeOf(player.sessionId)).revokedAt).not.toBeNull(),
      { timeout: 15_000 },
    );
  });

  it('revokes the live session of a cooled-off player on the reconcile pass', async () => {
    const player = await fundedPlayer(app, '100');
    const bystander = await fundedPlayer(app, '100');
    const res = await player.client.post('/compliance/rg/cooling-off', { durationHours: 24 });
    expect(res.status).toBe(200);
    await vi.waitFor(
      async () => {
        const [session] = await drizzle()
          .select({ providerRevokedAt: sportsbookSession.providerRevokedAt })
          .from(sportsbookSession)
          .where(eq(sportsbookSession.id, player.sessionId));
        expect(session?.providerRevokedAt).not.toBeNull();
      },
      { timeout: 15_000 },
    );
    await drizzle()
      .update(sportsbookSession)
      .set({ revokedAt: null, providerRevokedAt: null })
      .where(eq(sportsbookSession.id, player.sessionId));
    mockSportsbookProviderState.reset();

    await reconcilePass();
    await vi.waitFor(
      async () => {
        expect(await revokedAt(player.sessionId)).not.toBeNull();
        expect(mockSportsbookProviderState.revoked).toContain(player.sessionId);
      },
      { timeout: 15_000 },
    );
    const audited = await drizzle()
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.action, 'sportsbook.sessions.revoked'),
          eq(auditLog.resourceId, player.userId),
        ),
      )
      .orderBy(asc(auditLog.seq));
    expect(audited.at(-1)).toMatchObject({
      after: { revokedSessions: [player.sessionId], trigger: 'reconcile' },
    });
    expect(await revokedAt(bystander.sessionId)).toBeNull();
  });

  it('refuses a stake from a cooled-off player whose session revoke was lost', async () => {
    const player = await fundedPlayer(app, '100');
    const res = await player.client.post('/compliance/rg/cooling-off', { durationHours: 24 });
    expect(res.status).toBe(200);
    await vi.waitFor(async () => expect(await revokedAt(player.sessionId)).not.toBeNull(), {
      timeout: 15_000,
    });
    await drizzle()
      .update(sportsbookSession)
      .set({ revokedAt: null })
      .where(eq(sportsbookSession.id, player.sessionId));

    expect(
      await ledgerOf(app).session({ provider: PROVIDER, sessionId: player.sessionId }),
    ).toEqual({ status: 'refused', reason: 'cooling_off' });
    expect(await ledgerOf(app).reserve(reserveArgs(player.sessionId))).toEqual({
      status: 'refused',
      reason: 'cooling_off',
    });
    expect(await balanceOf(app, player.userId)).toBe('100.000000000000000000');
  });

  it('re-evaluates the loss limit when a reopen takes a win back', async () => {
    const player = await fundedPlayer(app, '100');
    const limit = await admin.put(`/compliance/players/${player.userId}/limits`, {
      type: 'loss',
      amount: '100',
      minutes: null,
      currency: 'USD',
      period: 'daily',
      reason: 'loss limit for the reopen check',
      confirm: true,
    });
    expect(limit.status).toBe(200);
    const { args } = await acceptedBet(app, player, { stake: '90', potentialPayout: '200' });
    await vi.waitFor(async () => expect(await lossFlagStatus(player.userId)).toEqual(['active']), {
      timeout: 15_000,
    });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '200',
      }),
    );
    await vi.waitFor(async () => expect(await lossFlagStatus(player.userId)).toEqual(['cleared']), {
      timeout: 15_000,
    });

    expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
      }),
    );
    await vi.waitFor(async () => expect(await lossFlagStatus(player.userId)).toContain('active'), {
      timeout: 15_000,
    });
  });
  it('re-evaluates the loss limit when an admin collects a debt into its round', async () => {
    const player = await fundedPlayer(app, '100');
    const won = await acceptedBet(app, player, { stake: '10', potentialPayout: '50' });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: won.args.providerBetId,
        result: 'won',
        payout: '50',
      }),
    );
    await acceptedBet(app, player, { stake: '140', potentialPayout: '300' });
    expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: won.args.providerBetId,
      }),
    );
    const limit = await admin.put(`/compliance/players/${player.userId}/limits`, {
      type: 'loss',
      amount: '150',
      minutes: null,
      currency: 'USD',
      period: 'daily',
      reason: 'loss limit for the debt collect check',
      confirm: true,
    });
    expect(limit.status).toBe(200);
    await deposit(player.client, '40');
    const debts = await admin.get(`/backoffice/sportsbook/debts?userId=${player.userId}`);
    const [debt] = ((await debts.json()) as { items: { id: string }[] }).items;
    expect(await lossFlagStatus(player.userId)).toEqual([]);
    const enqueue = vi.spyOn(app.container.get(JOB_QUEUE), 'enqueue');

    try {
      const collected = await admin.post(`/backoffice/sportsbook/debts/${debt!.id}/collect`, {
        idempotencyKey: randomUUID(),
      });
      expect(collected.status).toBe(200);
      await vi.waitFor(() =>
        expect(enqueue.mock.calls.map(([, payload]) => payload)).toContainEqual({
          userId: player.userId,
          trigger: 'sportsbook.debt.changed',
        }),
      );
    } finally {
      enqueue.mockRestore();
    }
    await vi.waitFor(async () => expect(await lossFlagStatus(player.userId)).toEqual(['active']), {
      timeout: 15_000,
    });
  });
});

describe('sportsbook hot queries use their indexes', () => {
  // Mostly sessions that expired without a revoke, which stay in every revoked_at IS NULL index;
  // seeded and analyzed, then rolled back, so the planner prices them.
  const plan = async (query: ReturnType<typeof sql>) => {
    let explained = '';
    await drizzle()
      .transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`insert into sportsbook_session (user_id, provider, currency, country_code, expires_at)
          select gen_random_uuid(), ${PROVIDER}, 'EUR', 'MT',
            now() + case when n <= 200 then interval '1 hour' else interval '-1 day' end
          from generate_series(1, 10000) as n`);
        await tx.execute(sql`analyze sportsbook_session`);
        const result = await tx.execute(sql`explain (format json) ${query}`);
        explained = JSON.stringify(result.rows);
        tx.rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof TransactionRollbackError)) {
          throw err;
        }
      });
    return explained;
  };

  it.each([
    {
      name: 'stale reserves',
      index: 'sportsbook_bet_reserved_created_at_idx',
      query: sql`select id from sportsbook_bet where status = 'reserved' and created_at < now() and reconcile_attempts < ${betting.SPORTSBOOK_RECONCILE_MAX_ATTEMPTS} order by created_at, id limit 200`,
    },
    {
      name: 'overdue settlements',
      index: 'sportsbook_bet_accepted_last_leg_starts_at_idx',
      query: sql`select id from sportsbook_bet where status = 'accepted' and last_leg_starts_at < now() order by last_leg_starts_at, id limit 200`,
    },
    {
      name: 'a bet by its provider id',
      index: 'sportsbook_bet_provider_provider_bet_id_idx',
      query: sql`select id from sportsbook_bet where provider = ${PROVIDER} and provider_bet_id = 'bet-x'`,
    },
    {
      name: 'a provider transaction',
      index: 'sportsbook_bet_transaction_provider_provider_tx_id_idx',
      query: sql`select id from sportsbook_bet_transaction where provider = ${PROVIDER} and provider_tx_id = 'tx-x'`,
    },
    {
      name: 'a player live sessions',
      index: 'sportsbook_session_user_id_live_idx',
      query: sql`select id from sportsbook_session where user_id = ${randomUUID()} and revoked_at is null and expires_at > now()`,
    },
    {
      name: 'live sessions across players',
      index: 'sportsbook_session_expires_at_live_idx',
      query: sql`select distinct user_id from sportsbook_session where revoked_at is null and expires_at > now() order by user_id limit 200`,
    },
    {
      name: 'unacknowledged provider revokes',
      index: 'sportsbook_session_unacknowledged_expires_at_id_idx',
      query: sql`select id from sportsbook_session where provider = ${PROVIDER} and revoked_at is not null and provider_revoked_at is null and expires_at > now() order by provider_revoke_attempted_at asc nulls first, expires_at, id limit 200`,
    },
    {
      name: 'a bet findings of one kind',
      index: 'sportsbook_reconciliation_finding_bet_id_kind_idx',
      query: sql`select id from sportsbook_reconciliation_finding where bet_id = gen_random_uuid() and kind = 'settlement_overdue'`,
    },
  ])('$name', async ({ index, query }) => {
    expect(await plan(query)).toContain(index);
  });
});
