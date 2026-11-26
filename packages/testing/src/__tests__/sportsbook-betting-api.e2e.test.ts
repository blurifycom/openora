import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import * as z from 'zod';
import { PLAY_ELIGIBILITY_PROJECTION } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import { betting } from '@openora/core/sportsbook/contracts';
import { user } from '@openora/core/pam/schema/identity';
import { player as playerProfile } from '@openora/core/pam/schema/profile';
import { backfillPlayEligibility } from '@openora/core/pam/identity/seed';
import { sportsbookSession } from '@openora/core/sportsbook/schema/betting';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { closeE2e, type E2e, type TestApp, type TestClient } from '../index.js';
import { mockSportsbookProviderState } from '../test-sportsbook-provider-plugin.js';
import {
  PLAYER_IP,
  PROVIDER,
  acceptedBet,
  auditRows,
  balanceOf,
  betIdOf,
  bootSportsbookApp,
  deposit,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  money,
  newSportsbookAccount,
  openSession,
  reserveArgs,
  settleBet,
  txId,
  type SportsbookPlayer,
} from './support/sportsbook.js';

let e2e: E2e;
let admin: TestClient;
const app = (): TestApp => e2e.app;

beforeAll(async () => {
  e2e = await bootSportsbookApp();
  admin = await enableSportsbook(e2e.app);
}, 60_000);

afterAll(() => closeE2e(e2e));

beforeEach(() => mockSportsbookProviderState.reset());

const BO = '/backoffice/sportsbook';

const pageOf = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number(), page: z.number(), limit: z.number() });

const ErrorBodySchema = z.object({ data: z.object({ reason: z.string() }) });

async function errorReason(res: Response) {
  return ErrorBodySchema.parse(await res.json()).data.reason;
}

const send = (client: Pick<TestClient, 'request'>, method: string, path: string, body?: unknown) =>
  client.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const anonymous = () => app().app;

const guest: Pick<TestClient, 'request'> = {
  request: async (path, init) => anonymous().request(path, init),
};

const putConfig = (overrides: Record<string, unknown> = {}) =>
  admin.put(`${BO}/config`, {
    enabled: true,
    currencies: [
      { currency: 'USD', decimals: 2 },
      { currency: 'EUR', decimals: 2 },
    ],
    blockedCountries: [],
    reserveTimeoutSeconds: 30,
    settlementGraceMinutes: 10,
    sessionTtlMinutes: 60,
    ...overrides,
  });

const sessionsOf = (userId: string) =>
  app()
    .container.get(DRIZZLE)
    .db.select()
    .from(sportsbookSession)
    .where(eq(sportsbookSession.userId, userId));

const sportsbookWalletRows = (userId: string) =>
  app()
    .container.get(DRIZZLE)
    .db.select({ id: walletTransaction.id, type: walletTransaction.type })
    .from(walletTransaction)
    .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
    .where(and(eq(wallet.userId, userId), like(walletTransaction.providerName, 'sportsbook:%')));

async function reproject() {
  const { db } = app().container.get(DRIZZLE);
  await backfillPlayEligibility(db, app().container.get(PLAY_ELIGIBILITY_PROJECTION));
}

async function setUser(userId: string, values: Partial<typeof user.$inferInsert>) {
  await app().container.get(DRIZZLE).db.update(user).set(values).where(eq(user.id, userId));
  await reproject();
}

async function setPlayerStatus(userId: string, status: typeof playerProfile.$inferInsert.status) {
  await app()
    .container.get(DRIZZLE)
    .db.update(playerProfile)
    .set({ status })
    .where(eq(playerProfile.userId, userId));
  await reproject();
}

const availability = async (ip: string) => {
  const res = await anonymous().request('/sportsbook/availability', {
    headers: { 'x-real-ip': ip },
  });
  expect(res.status).toBe(200);
  return betting.SportsbookAvailabilitySchema.parse(await res.json());
};

async function ownBets(client: TestClient, query = '') {
  const res = await client.get(`/sportsbook/bets${query}`);
  expect(res.status).toBe(200);
  return pageOf(betting.SportsbookBetSchema).parse(await res.json());
}

async function playerInDebt() {
  const player = await fundedPlayer(app(), '100');
  const won = await acceptedBet(app(), player, { stake: '10', potentialPayout: '50' });
  expectApplied(await settleBet(app(), won.args.providerBetId, 'won', '50'));
  expect(await balanceOf(app(), player.userId)).toBe(money(140));
  await acceptedBet(app(), player, { stake: '130', potentialPayout: '200' });
  expect(await balanceOf(app(), player.userId)).toBe(money(10));
  expectApplied(
    await ledgerOf(app()).reopen({
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId: won.args.providerBetId,
    }),
  );
  expect(await balanceOf(app(), player.userId)).toBe(money(0));
  const listed = await admin.get(`${BO}/debts?userId=${player.userId}`);
  expect(listed.status).toBe(200);
  const { items } = pageOf(betting.SportsbookDebtSchema).parse(await listed.json());
  const [debt] = items;
  if (!debt) {
    throw new Error('the reopen left no debt');
  }
  expect(debt).toMatchObject({ owed: money(40), outstanding: money(40), status: 'open' });
  return { player, debt };
}

describe('player sportsbook session and bets', () => {
  it('a player requests a sportsbook session and receives a token bound to that player', async () => {
    const { client, userId } = await newSportsbookAccount(app());
    const res = await openSession(client, 'usd');
    expect(res.status).toBe(200);
    const session = betting.SportsbookSessionSchema.parse(await res.json());

    expect(session.token).toBe(`token-${session.sessionId}`);
    expect(session.currency).toBe('USD');
    expect(mockSportsbookProviderState.issued).toEqual([
      expect.objectContaining({ sessionId: session.sessionId, userId, currency: 'USD' }),
    ]);
    const rows = await sessionsOf(userId);
    expect(rows).toEqual([
      expect.objectContaining({ id: session.sessionId, userId, revokedAt: null }),
    ]);
    expect(
      await ledgerOf(app()).session({ provider: PROVIDER, sessionId: session.sessionId }),
    ).toMatchObject({ status: 'ok', userId, currency: 'USD', browseOnly: false });

    const other = await newSportsbookAccount(app());
    const otherSession = betting.SportsbookSessionSchema.parse(
      await (await openSession(other.client)).json(),
    );
    expect(otherSession.sessionId).not.toBe(session.sessionId);
    expect(await sessionsOf(userId)).toHaveLength(1);
  });

  it('a player with a closed, excluded or restricted account is refused a session', async () => {
    const cases = [
      {
        reason: 'self_excluded',
        apply: (userId: string) => setUser(userId, { rgBlocked: true, rgBlockedUntil: null }),
      },
      {
        reason: 'cooling_off',
        apply: (userId: string) =>
          setUser(userId, { rgBlocked: true, rgBlockedUntil: new Date(Date.now() + 3_600_000) }),
      },
      { reason: 'account_closed', apply: (userId: string) => setPlayerStatus(userId, 'closed') },
    ];
    for (const { reason, apply } of cases) {
      const { client, userId } = await newSportsbookAccount(app());
      await apply(userId);
      const res = await openSession(client);
      expect(res.status).toBe(403);
      expect(await errorReason(res)).toBe(reason);
      expect(await sessionsOf(userId)).toHaveLength(0);
    }
    expect(mockSportsbookProviderState.issued).toHaveLength(0);

    const restricted = await fundedPlayer(app(), '100');
    const restriction = await send(
      admin,
      'POST',
      `${BO}/players/${restricted.userId}/restriction`,
      { reason: 'affordability review' },
    );
    expect(restriction.status).toBe(200);
    const browse = betting.SportsbookSessionSchema.parse(
      await (await openSession(restricted.client)).json(),
    );
    expect(browse.browseOnly).toBe(true);
    expect(await ledgerOf(app()).reserve(reserveArgs(browse.sessionId))).toEqual({
      status: 'refused',
      reason: 'sportsbook_restricted',
    });
    expect(await balanceOf(app(), restricted.userId)).toBe(money(100));
  });

  it('revoking a session makes its token unusable', async () => {
    const player = await fundedPlayer(app(), '100');
    const res = await send(player.client, 'DELETE', '/sportsbook/session', {
      sessionId: player.sessionId,
    });
    expect(res.status).toBe(200);
    expect(betting.RevokeSportsbookSessionOutputSchema.parse(await res.json())).toEqual({
      revoked: 1,
    });

    const [row] = await sessionsOf(player.userId);
    expect(row?.revokedAt).not.toBeNull();
    expect(mockSportsbookProviderState.revoked).toEqual([player.sessionId]);
    expect(
      await ledgerOf(app()).session({ provider: PROVIDER, sessionId: player.sessionId }),
    ).toEqual({ status: 'refused', reason: 'session_invalid' });
    expect(await ledgerOf(app()).reserve(reserveArgs(player.sessionId))).toEqual({
      status: 'refused',
      reason: 'session_invalid',
    });
    expect(await balanceOf(app(), player.userId)).toBe(money(100));
    expect(await sportsbookWalletRows(player.userId)).toHaveLength(0);

    const again = await send(player.client, 'DELETE', '/sportsbook/session', {
      sessionId: player.sessionId,
    });
    expect(betting.RevokeSportsbookSessionOutputSchema.parse(await again.json())).toEqual({
      revoked: 0,
    });
    expect(mockSportsbookProviderState.revoked).toEqual([player.sessionId]);
    const audit = await auditRows(app(), 'sportsbook.sessions.revoked', player.userId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorType: 'player',
      actorId: player.userId,
      after: { revokedSessions: [player.sessionId] },
    });
  });

  it("the own bet list and bet detail return only the caller's bets", async () => {
    const alice = await fundedPlayer(app(), '100');
    const bob = await fundedPlayer(app(), '100');
    const aliceAccepted = await acceptedBet(app(), alice, { stake: '10' });
    const aliceReserved = betIdOf(
      await ledgerOf(app()).reserve(
        reserveArgs(alice.sessionId, { stake: '5', potentialPayout: '9' }),
      ),
    );
    const bobBet = await acceptedBet(app(), bob, { stake: '20' });

    const list = await ownBets(alice.client);
    expect(list.total).toBe(2);
    expect(list.items.map((b) => b.id).sort()).toEqual([aliceAccepted.betId, aliceReserved].sort());
    expect(list.items.map((b) => b.id)).not.toContain(bobBet.betId);
    const reserved = await ownBets(alice.client, '?status=reserved');
    expect(reserved.items.map((b) => b.id)).toEqual([aliceReserved]);

    const detail = await bob.client.get(`/sportsbook/bets/${bobBet.betId}`);
    expect(detail.status).toBe(200);
    expect(betting.SportsbookBetSchema.parse(await detail.json())).toMatchObject({
      id: bobBet.betId,
      status: 'accepted',
      stake: money(20),
    });
    expect((await ownBets(bob.client)).items.map((b) => b.id)).toEqual([bobBet.betId]);
  });

  it("reading another player's bet by id or transaction returns not found", async () => {
    const reader = await fundedPlayer(app(), '100');
    const owner = await fundedPlayer(app(), '100');
    const { betId } = await acceptedBet(app(), owner, { stake: '10' });
    const [ownerRow] = await sportsbookWalletRows(owner.userId);
    if (!ownerRow) {
      throw new Error('the bet left no wallet row');
    }

    const byId = await reader.client.get(`/sportsbook/bets/${betId}`);
    expect(byId.status).toBe(404);
    expect(await byId.text()).not.toContain(owner.userId);
    const byTransaction = await reader.client.get(`/sportsbook/bets/by-transaction/${ownerRow.id}`);
    expect(byTransaction.status).toBe(404);
    expect(await byTransaction.text()).not.toContain(betId);
    expect((await reader.client.get(`/sportsbook/bets/${randomUUID()}`)).status).toBe(404);

    const own = await owner.client.get(`/sportsbook/bets/by-transaction/${ownerRow.id}`);
    expect(own.status).toBe(200);
    expect(betting.SportsbookBetSchema.parse(await own.json()).id).toBe(betId);
    expect((await ownBets(reader.client)).total).toBe(0);
  });

  it('availability reports unavailable while the sportsbook is suspended', async () => {
    expect(await availability(PLAYER_IP)).toEqual({ available: true, reason: null });
    const suspended = await send(admin, 'POST', `${BO}/suspend`, { reason: 'provider incident' });
    expect(suspended.status).toBe(200);
    try {
      expect(await availability(PLAYER_IP)).toEqual({ available: false, reason: 'unavailable' });
      const { client } = await newSportsbookAccount(app());
      expect((await openSession(client)).status).toBe(503);
      expect(mockSportsbookProviderState.issued).toHaveLength(0);
    } finally {
      await send(admin, 'POST', `${BO}/resume`, { reason: 'incident over' });
    }
    expect(await availability(PLAYER_IP)).toEqual({ available: true, reason: null });
  });

  it('session issue without a login is rejected as unauthorized', async () => {
    const res = await anonymous().request('/sportsbook/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': PLAYER_IP },
      body: JSON.stringify({ currency: 'USD' }),
    });
    expect(res.status).toBe(401);
    expect(mockSportsbookProviderState.issued).toHaveLength(0);
    const revoke = await anonymous().request('/sportsbook/session', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(revoke.status).toBe(401);
  });
});

describe('admin sportsbook operations', () => {
  it('an admin lists and reads bets of any player', async () => {
    const first = await fundedPlayer(app(), '100');
    const second = await fundedPlayer(app(), '100');
    const firstBet = await acceptedBet(app(), first);
    const secondBet = await acceptedBet(app(), second);

    const all = await admin.get(`${BO}/bets?limit=100`);
    expect(all.status).toBe(200);
    const ids = pageOf(betting.AdminSportsbookBetSchema)
      .parse(await all.json())
      .items.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([firstBet.betId, secondBet.betId]));

    const mine = await admin.get(`${BO}/bets?userId=${first.userId}`);
    const mineItems = pageOf(betting.AdminSportsbookBetSchema).parse(await mine.json()).items;
    expect(mineItems.map((b) => b.id)).toEqual([firstBet.betId]);
    expect(mineItems[0]?.userId).toBe(first.userId);

    const detail = await admin.get(`${BO}/bets/${secondBet.betId}`);
    expect(detail.status).toBe(200);
    const body = betting.AdminSportsbookBetDetailSchema.parse(await detail.json());
    expect(body).toMatchObject({ id: secondBet.betId, userId: second.userId, status: 'accepted' });
    expect(body.transactions.map((t) => t.kind)).toEqual(['reserve', 'confirm']);
  });

  it('an admin aligns a bet with the provider state and the change is audited', async () => {
    const player = await fundedPlayer(app(), '100');
    const { args, betId } = await acceptedBet(app(), player, {
      stake: '10',
      potentialPayout: '25',
    });
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '25',
    });

    const res = await admin.post(`${BO}/bets/${betId}/align`);
    expect(res.status).toBe(200);
    const body = betting.AlignSportsbookBetOutputSchema.parse(await res.json());
    expect(body.applied).toEqual(['settle']);
    expect(body.bet).toMatchObject({ status: 'settled', result: 'won', payoutTotal: money(25) });
    expect(await balanceOf(app(), player.userId)).toBe(money(115));

    const audit = await auditRows(app(), 'sportsbook.bet.aligned', betId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'admin', resourceType: 'sportsbook_bet' });
    expect(audit[0]?.actorId).not.toBeNull();

    const again = await admin.post(`${BO}/bets/${betId}/align`);
    expect(again.status).toBe(200);
    expect(betting.AlignSportsbookBetOutputSchema.parse(await again.json()).applied).toEqual([]);
    expect(await balanceOf(app(), player.userId)).toBe(money(115));
    expect(await auditRows(app(), 'sportsbook.bet.aligned', betId)).toHaveLength(1);
    expect(await sportsbookWalletRows(player.userId)).toHaveLength(2);
  });

  it('an admin updates the config and suspends then resumes the sportsbook and each action is audited', async () => {
    const player = await fundedPlayer(app(), '100');
    const { args } = await acceptedBet(app(), player, { stake: '10', potentialPayout: '25' });
    const configBefore = (await auditRows(app(), 'sportsbook.config.set')).length;
    const suspendedBefore = (await auditRows(app(), 'sportsbook.config.suspended')).length;
    const resumedBefore = (await auditRows(app(), 'sportsbook.config.resumed')).length;

    try {
      const updated = await putConfig({ sessionTtlMinutes: 61 });
      expect(updated.status).toBe(200);
      expect(betting.SportsbookConfigSchema.parse(await updated.json()).sessionTtlMinutes).toBe(61);
      const configRows = await auditRows(app(), 'sportsbook.config.set');
      expect(configRows).toHaveLength(configBefore + 1);
      expect(
        configRows.some((r) => JSON.stringify(r.after).includes('"sessionTtlMinutes":61')),
      ).toBe(true);
      expect((await putConfig({ sessionTtlMinutes: 61 })).status).toBe(200);
      expect(await auditRows(app(), 'sportsbook.config.set')).toHaveLength(configBefore + 1);

      const suspend = await send(admin, 'POST', `${BO}/suspend`, {
        reason: 'provider incident 42',
      });
      expect(suspend.status).toBe(200);
      expect(betting.SportsbookConfigSchema.parse(await suspend.json()).suspended).toBe(true);
      const suspendRows = await auditRows(app(), 'sportsbook.config.suspended');
      expect(suspendRows).toHaveLength(suspendedBefore + 1);
      expect(
        suspendRows.some((r) => JSON.stringify(r.after).includes('provider incident 42')),
      ).toBe(true);
      expect((await send(admin, 'POST', `${BO}/suspend`, { reason: 'again' })).status).toBe(200);
      expect(await auditRows(app(), 'sportsbook.config.suspended')).toHaveLength(
        suspendedBefore + 1,
      );

      expect(await ledgerOf(app()).reserve(reserveArgs(player.sessionId))).toEqual({
        status: 'refused',
        reason: 'suspended',
      });
      expect(await balanceOf(app(), player.userId)).toBe(money(90));
      expect(await settleBet(app(), args.providerBetId, 'won', '25')).toMatchObject({
        status: 'applied',
        betStatus: 'settled',
      });
      expect(await balanceOf(app(), player.userId)).toBe(money(115));

      const resume = await send(admin, 'POST', `${BO}/resume`, { reason: 'incident closed' });
      expect(resume.status).toBe(200);
      expect(betting.SportsbookConfigSchema.parse(await resume.json()).suspended).toBe(false);
      expect(await auditRows(app(), 'sportsbook.config.resumed')).toHaveLength(resumedBefore + 1);
      expectApplied(await ledgerOf(app()).reserve(reserveArgs(player.sessionId)));
      expect(await balanceOf(app(), player.userId)).toBe(money(105));
    } finally {
      await send(admin, 'POST', `${BO}/resume`, { reason: 'cleanup' });
      await putConfig();
    }
  });

  it("an admin restricts and lifts a restriction on a player and the player's session requests follow", async () => {
    const player = await fundedPlayer(app(), '100');
    const path = `${BO}/players/${player.userId}/restriction`;

    const restricted = await send(admin, 'POST', path, { reason: 'self-exclusion request' });
    expect(restricted.status).toBe(200);
    expect(betting.SportsbookRestrictionSchema.parse(await restricted.json())).toMatchObject({
      userId: player.userId,
      restricted: true,
      reason: 'self-exclusion request',
    });
    expect(mockSportsbookProviderState.revoked).toEqual([player.sessionId]);
    expect(await ledgerOf(app()).reserve(reserveArgs(player.sessionId))).toEqual({
      status: 'refused',
      reason: 'session_invalid',
    });
    const browse = betting.SportsbookSessionSchema.parse(
      await (await openSession(player.client)).json(),
    );
    expect(browse.browseOnly).toBe(true);
    expect(await ledgerOf(app()).reserve(reserveArgs(browse.sessionId))).toEqual({
      status: 'refused',
      reason: 'sportsbook_restricted',
    });
    expect(await balanceOf(app(), player.userId)).toBe(money(100));

    const lifted = await send(admin, 'DELETE', path, {
      userId: player.userId,
      reason: 'review passed',
    });
    expect(lifted.status).toBe(200);
    expect(betting.SportsbookRestrictionSchema.parse(await lifted.json())).toMatchObject({
      restricted: false,
      reason: null,
    });
    const fresh = betting.SportsbookSessionSchema.parse(
      await (await openSession(player.client)).json(),
    );
    expect(fresh.browseOnly).toBe(false);
    expectApplied(await ledgerOf(app()).reserve(reserveArgs(fresh.sessionId)));
    expect(await balanceOf(app(), player.userId)).toBe(money(90));

    const audit = await auditRows(app(), 'sportsbook.restriction.changed', player.userId);
    expect(audit).toHaveLength(2);
    expect(audit.map((r) => JSON.stringify(r.after)).join('')).toContain('review passed');
    expect(audit.every((r) => r.actorType === 'admin')).toBe(true);
  });

  it('an admin lists findings and resolves one, and resolving twice is refused', async () => {
    const player = await fundedPlayer(app(), '100');
    const args = reserveArgs(player.sessionId);
    const betId = betIdOf(await ledgerOf(app()).reserve(args));
    expect(await ledgerOf(app()).reserve({ ...args, stake: '11' })).toEqual({
      status: 'refused',
      reason: 'fingerprint_mismatch',
    });
    expect(await balanceOf(app(), player.userId)).toBe(money(90));

    const listed = await admin.get(
      `${BO}/findings?kind=fingerprint_mismatch&status=open&limit=100`,
    );
    expect(listed.status).toBe(200);
    const finding = pageOf(betting.SportsbookFindingSchema)
      .parse(await listed.json())
      .items.find((f) => f.betId === betId);
    if (!finding) {
      throw new Error('the mismatch filed no finding');
    }
    expect(finding).toMatchObject({ status: 'open', userId: player.userId, resolvedBy: null });

    const path = `${BO}/findings/${finding.id}/resolve`;
    const resolved = await send(admin, 'POST', path, { note: 'provider retried with a new stake' });
    expect(resolved.status).toBe(200);
    expect(betting.SportsbookFindingSchema.parse(await resolved.json())).toMatchObject({
      id: finding.id,
      status: 'resolved',
      resolutionNote: 'provider retried with a new stake',
    });
    expect(await auditRows(app(), 'sportsbook.finding.resolved', finding.id)).toHaveLength(1);

    const second = await send(admin, 'POST', path, { note: 'again' });
    expect(second.status).toBe(409);
    expect(await errorReason(second)).toBe('finding_resolved');
    expect(await auditRows(app(), 'sportsbook.finding.resolved', finding.id)).toHaveLength(1);
    const stillOpen = await admin.get(
      `${BO}/findings?kind=fingerprint_mismatch&status=open&limit=100`,
    );
    expect(
      pageOf(betting.SportsbookFindingSchema)
        .parse(await stillOpen.json())
        .items.map((f) => f.id),
    ).not.toContain(finding.id);
  });

  it('collecting or writing off a debt changes its status once and a repeat is refused', async () => {
    const collected = await playerInDebt();
    await deposit(collected.player.client, '100');
    const collectPath = `${BO}/debts/${collected.debt.id}/collect`;
    const collect = await send(admin, 'POST', collectPath, { idempotencyKey: randomUUID() });
    expect(collect.status).toBe(200);
    expect(betting.SportsbookDebtSchema.parse(await collect.json())).toMatchObject({
      collected: money(40),
      outstanding: money(0),
      status: 'cleared',
      holdActive: false,
    });
    expect(await balanceOf(app(), collected.player.userId)).toBe(money(60));
    const repeat = await send(admin, 'POST', collectPath, { idempotencyKey: randomUUID() });
    expect(repeat.status).toBe(409);
    expect(await errorReason(repeat)).toBe('debt_cleared');
    expect(await balanceOf(app(), collected.player.userId)).toBe(money(60));
    const collectAudit = await auditRows(app(), 'sportsbook.debt.changed', collected.debt.id);
    expect(
      collectAudit.filter((r) => JSON.stringify(r.after).includes('"cause":"collected"')),
    ).toHaveLength(1);

    const forgiven = await playerInDebt();
    const writeOffPath = `${BO}/debts/${forgiven.debt.id}/write-off`;
    const writeOff = await send(admin, 'POST', writeOffPath, {
      reason: 'goodwill after provider error',
      idempotencyKey: randomUUID(),
    });
    expect(writeOff.status).toBe(200);
    expect(betting.SportsbookDebtSchema.parse(await writeOff.json())).toMatchObject({
      status: 'written_off',
      writtenOff: money(40),
      outstanding: money(0),
      holdActive: false,
      writtenOffReason: 'goodwill after provider error',
    });
    const second = await send(admin, 'POST', writeOffPath, {
      reason: 'again',
      idempotencyKey: randomUUID(),
    });
    expect(second.status).toBe(409);
    expect(await errorReason(second)).toBe('debt_cleared');
    const collectAfter = await send(admin, 'POST', `${BO}/debts/${forgiven.debt.id}/collect`, {
      idempotencyKey: randomUUID(),
    });
    expect(collectAfter.status).toBe(409);
    expect(await balanceOf(app(), forgiven.player.userId)).toBe(money(0));
    const writeOffAudit = await auditRows(app(), 'sportsbook.debt.changed', forgiven.debt.id);
    expect(
      writeOffAudit.filter((r) => JSON.stringify(r.after).includes('"cause":"written_off"')),
    ).toHaveLength(1);
  });

  it('a non-admin calling any admin sportsbook route is refused as forbidden', async () => {
    const target: SportsbookPlayer = await fundedPlayer(app(), '100');
    const { betId } = await acceptedBet(app(), target);
    const plain = await fundedPlayer(app(), '100');
    const configBefore = await (await admin.get(`${BO}/config`)).text();
    const watched = [
      'sportsbook.config.set',
      'sportsbook.config.suspended',
      'sportsbook.config.resumed',
      'sportsbook.restriction.changed',
      'sportsbook.bet.aligned',
    ];
    const auditBefore = await Promise.all(watched.map((a) => auditRows(app(), a)));

    const id = randomUUID();
    const routes: [string, string, unknown?][] = [
      ['GET', `${BO}/bets`],
      ['GET', `${BO}/bets/${betId}`],
      ['POST', `${BO}/bets/${betId}/align`],
      ['GET', `${BO}/config`],
      [
        'PUT',
        `${BO}/config`,
        {
          enabled: true,
          currencies: [{ currency: 'USD', decimals: 2 }],
          blockedCountries: [],
          reserveTimeoutSeconds: 30,
          settlementGraceMinutes: 10,
          sessionTtlMinutes: 99,
        },
      ],
      ['POST', `${BO}/suspend`, { reason: 'intruder' }],
      ['POST', `${BO}/resume`, { reason: 'intruder' }],
      ['GET', `${BO}/players/${target.userId}/restriction`],
      ['POST', `${BO}/players/${target.userId}/restriction`, { reason: 'intruder' }],
      [
        'DELETE',
        `${BO}/players/${target.userId}/restriction`,
        { userId: target.userId, reason: 'intruder' },
      ],
      ['GET', `${BO}/players/${target.userId}/summary`],
      ['GET', `${BO}/findings`],
      ['POST', `${BO}/findings/${id}/resolve`, { note: 'intruder' }],
      ['GET', `${BO}/debts`],
      ['POST', `${BO}/debts/${id}/collect`, { idempotencyKey: randomUUID() }],
      ['POST', `${BO}/debts/${id}/write-off`, { reason: 'intruder', idempotencyKey: randomUUID() }],
      ['GET', `${BO}/promotions/report`],
    ];
    for (const [method, path, body] of routes) {
      const refused = await send(plain.client, method, path, body);
      expect([method, path, refused.status]).toEqual([method, path, 403]);
      const unauthenticated = await send(guest, method, path, body);
      expect([method, path, unauthenticated.status]).toEqual([method, path, 401]);
    }

    expect(await (await admin.get(`${BO}/config`)).text()).toBe(configBefore);
    const auditAfter = await Promise.all(watched.map((a) => auditRows(app(), a)));
    expect(auditAfter.map((rows) => rows.length)).toEqual(auditBefore.map((rows) => rows.length));
    expect(await balanceOf(app(), target.userId)).toBe(money(90));
    const restriction = await admin.get(`${BO}/players/${target.userId}/restriction`);
    expect(betting.SportsbookRestrictionSchema.parse(await restriction.json()).restricted).toBe(
      false,
    );
    expect(mockSportsbookProviderState.revoked).toHaveLength(0);
    expect(mockSportsbookProviderState.lookups).toHaveLength(0);
  });
});
