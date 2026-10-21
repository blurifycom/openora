import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, asc, desc, eq, like } from 'drizzle-orm';
import type { Paginated } from '@openora/core/contracts';
import { DRIZZLE } from '@openora/core/server';
import type { betting } from '@openora/core/sportsbook/contracts';
import { auditLog } from '@openora/core/audit/schema';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import {
  sportsbookBetTransaction,
  sportsbookPlayerRestriction,
  sportsbookSession,
} from '@openora/core/sportsbook/schema/betting';
import {
  assignIamRoleByKey,
  closeE2e,
  readJson,
  registerAndMaterializePlayer,
  type TestApp,
  type TestClient,
  type TestDb,
} from '../index.js';
import { mockSportsbookProviderState } from '../test-sportsbook-provider-plugin.js';
import {
  PLAYER_IP,
  PROVIDER,
  acceptedBet,
  balanceOf,
  bootSportsbookApp,
  deposit,
  enableSportsbook,
  expectApplied,
  fundedPlayer,
  ledgerOf,
  openSession,
  reserveArgs,
  txId,
  type SportsbookPlayer,
} from './fixtures/sportsbook.js';

type Bet = betting.SportsbookBet & Partial<Pick<betting.AdminSportsbookBet, 'userId'>>;
type Page<T> = Paginated<T>;
type Finding = betting.SportsbookFinding;
type Debt = betting.SportsbookDebt;
type Config = betting.SportsbookConfig;

let db: TestDb;
let app: TestApp;
let admin: TestClient;
let stranger: TestClient;

beforeAll(async () => {
  ({ db, app } = await bootSportsbookApp());
  admin = await enableSportsbook(app);
  stranger = (
    await registerAndMaterializePlayer(app, { email: `sportsbook-${randomUUID()}@example.com` })
  ).client;
}, 60_000);

afterAll(() => closeE2e({ app, db }));

beforeEach(() => mockSportsbookProviderState.reset());

const json = <T>(res: Response): Promise<T> => readJson(res);

const money = (amount: number) => `${amount}.000000000000000000`;

const anonymous = (path: string, init?: RequestInit) => app.app.request(path, init);

const del = (client: TestClient, path: string, body: unknown) =>
  client.request(path, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const auditRows = (action: string, resourceId?: string) =>
  app.container
    .get(DRIZZLE)
    .db.select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.action, action),
        resourceId ? eq(auditLog.resourceId, resourceId) : undefined,
      ),
    )
    .orderBy(desc(auditLog.seq));

const auditCount = async (action: string) => (await auditRows(action)).length;

type ErrorBody = { data?: Record<string, string> };

const conflictReason = async (res: Response) => {
  expect(res.status).toBe(409);
  return (await json<ErrorBody>(res)).data?.['reason'];
};

const sessionsOf = async (userId: string) =>
  app.container
    .get(DRIZZLE)
    .db.select()
    .from(sportsbookSession)
    .where(eq(sportsbookSession.userId, userId));

async function sportsbookManager(): Promise<TestClient> {
  const { client, userId } = await registerAndMaterializePlayer(app, {
    email: `sportsbook-manager-${randomUUID()}@example.com`,
  });
  await assignIamRoleByKey(app.container, userId, 'sportsbook-manager');
  return client;
}

const getConfig = async () => json<Config>(await admin.get('/backoffice/sportsbook/config'));

const putConfig = (overrides: Record<string, unknown> = {}) =>
  admin.put('/backoffice/sportsbook/config', {
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

const adminBet = async (betId: string) => {
  const res = await admin.get(`/backoffice/sportsbook/bets/${betId}`);
  expect(res.status).toBe(200);
  return json<betting.AdminSportsbookBet & { transactions: betting.SportsbookBetTransaction[] }>(
    res,
  );
};

const findingsFor = async (query: string) =>
  (await json<Page<Finding>>(await admin.get(`/backoffice/sportsbook/findings?${query}`))).items;

const debtOf = async (userId: string) => {
  const res = await admin.get(`/backoffice/sportsbook/debts?userId=${userId}`);
  expect(res.status).toBe(200);
  const { items } = await json<Page<Debt>>(res);
  expect(items).toHaveLength(1);
  return items[0]!;
};

async function playerInDebt(): Promise<{
  player: SportsbookPlayer;
  debt: Debt;
  pendingBet: { providerBetId: string };
  wonBet: { providerBetId: string };
}> {
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
  expect(await balanceOf(app, player.userId)).toBe(money(140));
  const open = await acceptedBet(app, player, { stake: '130', potentialPayout: '200' });
  expect(await balanceOf(app, player.userId)).toBe(money(10));
  expectApplied(
    await ledgerOf(app).reopen({
      provider: PROVIDER,
      providerTxId: txId(),
      providerBetId: won.args.providerBetId,
    }),
  );
  expect(await balanceOf(app, player.userId)).toBe(money(0));
  return { player, debt: await debtOf(player.userId), pendingBet: open.args, wonBet: won.args };
}

describe('sportsbook session route', () => {
  it('issues a session through the provider and returns the launch url', async () => {
    const { client } = await registerAndMaterializePlayer(app, {
      email: `sportsbook-${randomUUID()}@example.com`,
    });
    const res = await openSession(client, 'usd');
    expect(res.status).toBe(200);
    const body = await json<{
      sessionId: string;
      token: string;
      launchUrl: string | null;
      currency: string;
      expiresAt: string;
    }>(res);
    expect(body).toMatchObject({
      currency: 'USD',
      launchUrl: 'https://provider.test/launch',
      token: `token-${body.sessionId}`,
    });
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(mockSportsbookProviderState.issued).toHaveLength(1);
    expect(mockSportsbookProviderState.issued[0]).toMatchObject({
      sessionId: body.sessionId,
      currency: 'USD',
      countryCode: 'PL',
    });
    expect(mockSportsbookProviderState.issued[0]).not.toHaveProperty('locale');
  });

  it.each(['pt-BR', 'en-US-u-hc-h12'])(
    'passes the player locale %s to the provider',
    async (locale) => {
      const res = await openSession(stranger, 'USD', locale);
      expect(res.status).toBe(200);
      expect(mockSportsbookProviderState.issued).toHaveLength(1);
      expect(mockSportsbookProviderState.issued[0]).toMatchObject({ locale });
    },
  );

  it('rejects a malformed locale and issues nothing', async () => {
    expect((await openSession(stranger, 'USD', '')).status).toBe(400);
    expect((await openSession(stranger, 'USD', 'x'.repeat(36))).status).toBe(400);
    expect((await openSession(stranger, 'USD', 'en&currency=EUR')).status).toBe(400);
    expect(mockSportsbookProviderState.issued).toHaveLength(0);
  });

  it('answers 401 without a login and issues nothing', async () => {
    const res = await anonymous('/sportsbook/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': PLAYER_IP },
      body: JSON.stringify({ currency: 'USD' }),
    });
    expect(res.status).toBe(401);
    expect(mockSportsbookProviderState.issued).toHaveLength(0);
  });

  it('refuses a currency the sportsbook does not offer', async () => {
    const res = await openSession(stranger, 'GBP');
    expect(res.status).toBe(400);
    expect(mockSportsbookProviderState.issued).toHaveLength(0);
  });

  it('rejects a body without a currency', async () => {
    const res = await stranger.request('/sportsbook/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-real-ip': PLAYER_IP },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it('refuses while the sportsbook is suspended and again works after resume', async () => {
    const suspended = await admin.post('/backoffice/sportsbook/suspend', {
      reason: 'provider incident',
    });
    expect(suspended.status).toBe(200);
    try {
      const res = await openSession(stranger);
      expect(res.status).toBe(503);
      expect(mockSportsbookProviderState.issued).toHaveLength(0);
    } finally {
      await admin.post('/backoffice/sportsbook/resume', { reason: 'incident over' });
    }
    expect((await openSession(stranger)).status).toBe(200);
  });

  it('refuses a restricted player and lets them back once the restriction is lifted', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `sportsbook-${randomUUID()}@example.com`,
    });
    const restricted = await admin.post(`/backoffice/sportsbook/players/${userId}/restriction`, {
      reason: 'affordability review',
    });
    expect(restricted.status).toBe(200);

    const res = await openSession(client);
    expect(res.status).toBe(403);
    expect(mockSportsbookProviderState.issued).toHaveLength(0);

    const lifted = await del(admin, `/backoffice/sportsbook/players/${userId}/restriction`, {
      userId,
      reason: 'review passed',
    });
    expect(lifted.status).toBe(200);
    expect((await openSession(client)).status).toBe(200);
  });

  it('answers 503 when the provider cannot open the session and revokes it at both ends', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `sportsbook-${randomUUID()}@example.com`,
    });
    mockSportsbookProviderState.failIssue = true;
    const res = await openSession(client);
    expect(res.status).toBe(503);
    expect(mockSportsbookProviderState.issued).toHaveLength(0);
    const [session] = await sessionsOf(userId);
    expect(session?.revokedAt).not.toBeNull();
    expect(mockSportsbookProviderState.revoked).toContain(session!.id);
    expect(session?.providerRevokedAt).toBeNull();
    expect(session?.providerRevokeAttemptedAt).not.toBeNull();
  });

  it('answers 503 for a session revoked while the provider was opening it', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `sportsbook-${randomUUID()}@example.com`,
    });
    let revokedBeforeOpen = 0;
    mockSportsbookProviderState.onIssue = async () => {
      const restricted = await admin.post(`/backoffice/sportsbook/players/${userId}/restriction`, {
        reason: 'restricted mid-issue',
      });
      expect(restricted.status).toBe(200);
      revokedBeforeOpen = mockSportsbookProviderState.revoked.length;
    };
    const res = await openSession(client);
    expect(res.status).toBe(503);
    const [session] = await sessionsOf(userId);
    expect(session?.revokedAt).not.toBeNull();
    expect(mockSportsbookProviderState.revoked.slice(revokedBeforeOpen)).toContain(session!.id);
  });

  it('does not count a revoke sent while the provider was opening the session', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `sportsbook-${randomUUID()}@example.com`,
    });
    mockSportsbookProviderState.onIssue = async () => {
      const restricted = await admin.post(`/backoffice/sportsbook/players/${userId}/restriction`, {
        reason: 'restricted mid-issue',
      });
      expect(restricted.status).toBe(200);
      const [opening] = await sessionsOf(userId);
      expect(opening?.providerRevokedAt).toBeNull();
      mockSportsbookProviderState.failRevokes = 1;
    };
    expect((await openSession(client)).status).toBe(503);
    const [session] = await sessionsOf(userId);
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.providerRevokedAt).toBeNull();
    expect(mockSportsbookProviderState.failRevokes).toBe(0);
  });

  it('keeps a revoke pending when an open that may have succeeded fails and its cleanup fails', async () => {
    const { client, userId } = await registerAndMaterializePlayer(app, {
      email: `sportsbook-${randomUUID()}@example.com`,
    });
    mockSportsbookProviderState.onIssue = async () => {
      const restricted = await admin.post(`/backoffice/sportsbook/players/${userId}/restriction`, {
        reason: 'restricted mid-issue',
      });
      expect(restricted.status).toBe(200);
      mockSportsbookProviderState.failRevokes = 1;
      throw new Error('provider timed out after opening the session');
    };
    expect((await openSession(client)).status).toBe(503);
    const [session] = await sessionsOf(userId);
    expect(session?.revokedAt).not.toBeNull();
    expect(session?.providerRevokedAt).toBeNull();
    expect(mockSportsbookProviderState.failRevokes).toBe(0);
  });

  it('refuses a country on the sportsbook blocked list and issues nothing', async () => {
    await putConfig({ blockedCountries: ['DE', 'PL'] });
    try {
      const res = await openSession(stranger);
      expect(res.status).toBe(403);
      expect((await json<ErrorBody>(res)).data?.['reason']).toBe('geo_restricted');
      expect(mockSportsbookProviderState.issued).toHaveLength(0);
    } finally {
      await putConfig();
    }
    expect((await openSession(stranger)).status).toBe(200);
  });

  it('refuses a reserve on a session whose country was blocked after it opened', async () => {
    const player = await fundedPlayer(app, '50');
    await putConfig({ blockedCountries: ['PL'] });
    try {
      expect(await ledgerOf(app).reserve(reserveArgs(player.sessionId))).toEqual({
        status: 'refused',
        reason: 'session_invalid',
      });
      expect(await balanceOf(app, player.userId)).toBe(money(50));
    } finally {
      await putConfig();
    }
    expectApplied(await ledgerOf(app).reserve(reserveArgs(player.sessionId)));
  });
});

describe('sportsbook player bet routes', () => {
  let alice: SportsbookPlayer;
  let bob: SportsbookPlayer;
  let aliceBets: { betId: string }[];
  let bobBet: { betId: string };

  beforeAll(async () => {
    alice = await fundedPlayer(app, '100');
    bob = await fundedPlayer(app, '100');
    aliceBets = [
      await acceptedBet(app, alice, { stake: '10' }),
      await ledgerOf(app)
        .reserve(reserveArgs(alice.sessionId, { stake: '5', potentialPayout: '9' }))
        .then((o) => ({ betId: expectApplied(o).betId! })),
    ];
    bobBet = await acceptedBet(app, bob, { stake: '20' });
  });

  it('lists only the caller own bets and filters by status', async () => {
    const res = await alice.client.get('/sportsbook/bets');
    expect(res.status).toBe(200);
    const page = await json<Page<Bet>>(res);
    expect(page.total).toBe(2);
    expect(page.items.map((b) => b.id).sort()).toEqual(aliceBets.map((b) => b.betId).sort());
    expect(page.items.map((b) => b.id)).not.toContain(bobBet.betId);

    const reserved = await json<Page<Bet>>(
      await alice.client.get('/sportsbook/bets?status=reserved'),
    );
    expect(reserved.items.map((b) => b.id)).toEqual([aliceBets[1]!.betId]);

    const paged = await json<Page<Bet>>(await alice.client.get('/sportsbook/bets?limit=1&page=2'));
    expect(paged).toMatchObject({ total: 2, page: 2, limit: 1 });
    expect(paged.items).toHaveLength(1);
  });

  it('returns the caller own bet', async () => {
    const res = await bob.client.get(`/sportsbook/bets/${bobBet.betId}`);
    expect(res.status).toBe(200);
    expect(await json<Bet>(res)).toMatchObject({
      id: bobBet.betId,
      status: 'accepted',
      stake: money(20),
      version: 1,
    });
  });

  it('answers 404 with no bet data for another player bet', async () => {
    const res = await alice.client.get(`/sportsbook/bets/${bobBet.betId}`);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toContain(money(20));
    expect(text).not.toContain(bob.userId);
  });

  it('answers 404 for an unknown bet and 400 for a malformed id', async () => {
    expect((await alice.client.get(`/sportsbook/bets/${randomUUID()}`)).status).toBe(404);
    expect((await alice.client.get('/sportsbook/bets/not-a-uuid')).status).toBe(400);
  });

  it('answers 401 without a login', async () => {
    expect((await anonymous('/sportsbook/bets')).status).toBe(401);
    expect((await anonymous(`/sportsbook/bets/${bobBet.betId}`)).status).toBe(401);
  });

  it('rejects an unknown status filter', async () => {
    expect((await alice.client.get('/sportsbook/bets?status=bogus')).status).toBe(400);
  });
});

describe('sportsbook backoffice bet routes', () => {
  let player: SportsbookPlayer;
  let other: SportsbookPlayer;
  let bet: { betId: string; args: { providerBetId: string } };
  let otherBet: { betId: string };

  beforeAll(async () => {
    player = await fundedPlayer(app, '100');
    other = await fundedPlayer(app, '100');
    bet = await acceptedBet(app, player);
    otherBet = await acceptedBet(app, other);
  });

  it('lists bets across players with filters and reads one with its ledger transactions', async () => {
    const all = await admin.get('/backoffice/sportsbook/bets?limit=100');
    expect(all.status).toBe(200);
    const ids = (await json<Page<Bet>>(all)).items.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining([bet.betId, otherBet.betId]));

    const mine = await json<Page<Bet>>(
      await admin.get(`/backoffice/sportsbook/bets?userId=${player.userId}`),
    );
    expect(mine.items.map((b) => b.id)).toEqual([bet.betId]);
    expect(mine.items[0]).toMatchObject({ userId: player.userId });

    const byProviderId = await json<Page<Bet>>(
      await admin.get(
        `/backoffice/sportsbook/bets?provider=${PROVIDER}&providerBetId=${bet.args.providerBetId}`,
      ),
    );
    expect(byProviderId.items.map((b) => b.id)).toEqual([bet.betId]);

    const detail = await adminBet(bet.betId);
    expect(detail).toMatchObject({ id: bet.betId, userId: player.userId, status: 'accepted' });
    expect(detail.transactions.map((t) => t.kind)).toEqual(['reserve', 'confirm']);
  });

  it('refuses a provider bet id filter without the provider', async () => {
    const res = await admin.get(
      `/backoffice/sportsbook/bets?providerBetId=${bet.args.providerBetId}`,
    );
    expect(res.status).toBe(400);
  });

  it('answers 404 for an unknown bet and 400 for a malformed id', async () => {
    expect((await admin.get(`/backoffice/sportsbook/bets/${randomUUID()}`)).status).toBe(404);
    expect((await admin.get('/backoffice/sportsbook/bets/not-a-uuid')).status).toBe(400);
  });

  it('refuses a plain player and an anonymous caller', async () => {
    expect((await player.client.get('/backoffice/sportsbook/bets')).status).toBe(403);
    expect((await player.client.get(`/backoffice/sportsbook/bets/${bet.betId}`)).status).toBe(403);
    expect((await anonymous('/backoffice/sportsbook/bets')).status).toBe(401);
  });
});

describe('sportsbook bet align route', () => {
  it('settles an accepted bet the provider reports as won and credits the payout once', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '25',
    });

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    expect(res.status).toBe(200);
    const body = await json<{ bet: Bet; providerStatus: { status: string }; applied: string[] }>(
      res,
    );
    expect(body.applied).toEqual(['settle']);
    expect(body.providerStatus.status).toBe('settled');
    expect(body.bet).toMatchObject({
      status: 'settled',
      result: 'won',
      payoutTotal: money(25),
      userId: player.userId,
    });
    expect(await balanceOf(app, player.userId)).toBe(money(115));
    expect((await adminBet(betId)).status).toBe('settled');

    const audit = await auditRows('sportsbook.bet.aligned', betId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actorType: 'admin', resourceType: 'sportsbook_bet' });
    expect(audit[0]!.actorId).toBeTruthy();

    const again = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    expect(again.status).toBe(200);
    expect((await json<{ applied: string[] }>(again)).applied).toEqual([]);
    expect(await balanceOf(app, player.userId)).toBe(money(115));
    expect(await auditRows('sportsbook.bet.aligned', betId)).toHaveLength(1);
  });

  it('confirms a reserved bet the provider reports as accepted without moving money', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const betId = expectApplied(await ledgerOf(app).reserve(args)).betId!;
    mockSportsbookProviderState.statuses.set(args.providerBetId, { status: 'accepted' });

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    expect(res.status).toBe(200);
    const body = await json<{ bet: Bet; applied: string[] }>(res);
    expect(body.applied).toEqual(['confirm']);
    expect(body.bet.status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money(90));
    expect(await auditRows('sportsbook.bet.aligned', betId)).toHaveLength(1);
  });

  it('cancels a reserved bet the provider has never heard of and returns the stake', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const betId = expectApplied(await ledgerOf(app).reserve(args)).betId!;
    expect(await balanceOf(app, player.userId)).toBe(money(90));

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    expect(res.status).toBe(200);
    const body = await json<{ bet: Bet; applied: string[] }>(res);
    expect(body.applied).toEqual(['cancel']);
    expect(body.bet.status).toBe('cancelled');
    expect(await balanceOf(app, player.userId)).toBe(money(100));
  });

  it('files a provider mismatch finding and moves no money when the provider disagrees', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player);
    mockSportsbookProviderState.statuses.set(args.providerBetId, { status: 'rejected' });

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    expect(res.status).toBe(200);
    const body = await json<{ bet: Bet; applied: string[] }>(res);
    expect(body.applied).toEqual([]);
    expect(body.bet.status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money(90));

    const open = (await findingsFor('kind=provider_mismatch&status=open&limit=100')).filter(
      (f) => f.betId === betId,
    );
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ userId: player.userId, status: 'open' });
    expect((await auditRows('sportsbook.bet.aligned', betId)).length).toBeGreaterThan(0);

    await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    const stillOne = (await findingsFor('kind=provider_mismatch&status=open&limit=100')).filter(
      (f) => f.betId === betId,
    );
    expect(stillOne).toHaveLength(1);
  });

  it('answers 503 and moves nothing when the provider lookup fails', async () => {
    const player = await fundedPlayer(app, '100');
    const { betId } = await acceptedBet(app, player);
    mockSportsbookProviderState.failLookup = true;

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    expect(res.status).toBe(503);
    expect((await adminBet(betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money(90));
    expect(await auditRows('sportsbook.bet.aligned', betId)).toHaveLength(0);
  });

  it('answers 404 for an unknown bet and 400 for a malformed id', async () => {
    expect((await admin.post(`/backoffice/sportsbook/bets/${randomUUID()}/align`)).status).toBe(
      404,
    );
    expect((await admin.post('/backoffice/sportsbook/bets/not-a-uuid/align')).status).toBe(400);
  });

  it('refuses a plain player and an anonymous caller before touching the provider', async () => {
    const player = await fundedPlayer(app, '100');
    const { args, betId } = await acceptedBet(app, player, { potentialPayout: '25' });
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'won',
      payout: '25',
    });

    expect((await player.client.post(`/backoffice/sportsbook/bets/${betId}/align`)).status).toBe(
      403,
    );
    expect(
      (await anonymous(`/backoffice/sportsbook/bets/${betId}/align`, { method: 'POST' })).status,
    ).toBe(401);
    expect(
      (await (await sportsbookManager()).post(`/backoffice/sportsbook/bets/${betId}/align`)).status,
    ).toBe(403);
    expect(mockSportsbookProviderState.lookups).toEqual([]);
    expect((await adminBet(betId)).status).toBe('accepted');
    expect(await balanceOf(app, player.userId)).toBe(money(90));
  });

  it('answers 409 with what it applied when the ledger refuses a later step', async () => {
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
    await app.container
      .get(DRIZZLE)
      .db.insert(sportsbookBetTransaction)
      .values({
        provider: PROVIDER,
        providerTxId: `core-align:${betId}:v2:settle`,
        providerBetId: `bet-${randomUUID()}`,
        kind: 'cancel',
        fingerprint: 'another request',
      });
    mockSportsbookProviderState.statuses.set(args.providerBetId, {
      status: 'settled',
      result: 'lost',
      payout: '0',
    });

    const res = await admin.post(`/backoffice/sportsbook/bets/${betId}/align`);
    expect(res.status).toBe(409);
    expect((await json<ErrorBody>(res)).data).toEqual({
      reason: 'ledger_refused',
      refusal: 'fingerprint_mismatch',
      applied: 'reopen',
    });
    expect(await adminBet(betId)).toMatchObject({ status: 'accepted', version: 2 });
    expect(await balanceOf(app, player.userId)).toBe(money(90));
  });
});

describe('sportsbook config routes', () => {
  afterEach(async () => {
    await putConfig();
  });

  it('reads the config and refuses a plain player and an anonymous caller', async () => {
    const res = await admin.get('/backoffice/sportsbook/config');
    expect(res.status).toBe(200);
    expect(await json<Config>(res)).toMatchObject({
      enabled: true,
      suspended: false,
      currencies: [
        { currency: 'USD', decimals: 2 },
        { currency: 'EUR', decimals: 2 },
      ],
    });
    expect((await stranger.get('/backoffice/sportsbook/config')).status).toBe(403);
    expect((await anonymous('/backoffice/sportsbook/config')).status).toBe(401);
  });

  it('writes the config, audits the change and records nothing for an identical write', async () => {
    const before = await auditCount('sportsbook.config.set');
    const res = await putConfig({ sessionTtlMinutes: 61 });
    expect(res.status).toBe(200);
    expect((await json<Config>(res)).sessionTtlMinutes).toBe(61);
    expect((await getConfig()).sessionTtlMinutes).toBe(61);

    const rows = await auditRows('sportsbook.config.set');
    expect(rows).toHaveLength(before + 1);
    expect(rows[0]).toMatchObject({ actorType: 'admin', resourceType: 'sportsbook_config' });
    expect(rows[0]!.actorId).toBeTruthy();
    expect(rows[0]!.after).toMatchObject({ sessionTtlMinutes: 61 });
    expect(rows[0]!.before).toMatchObject({ sessionTtlMinutes: 60 });

    expect((await putConfig({ sessionTtlMinutes: 61 })).status).toBe(200);
    expect(await auditCount('sportsbook.config.set')).toBe(before + 1);
  });

  it('refuses enabling without currencies and keeps the config', async () => {
    const before = await auditCount('sportsbook.config.set');
    expect((await putConfig({ currencies: [] })).status).toBe(400);
    expect((await getConfig()).currencies).toHaveLength(2);
    expect(await auditCount('sportsbook.config.set')).toBe(before);
  });

  it('enables with an empty blocked list and stores a blocked list', async () => {
    expect((await getConfig()).blockedCountries).toEqual([]);
    expect((await putConfig({ blockedCountries: ['US', 'GB'] })).status).toBe(200);
    try {
      expect(await getConfig()).toMatchObject({ enabled: true, blockedCountries: ['US', 'GB'] });
    } finally {
      expect((await putConfig()).status).toBe(200);
    }
    expect(await getConfig()).toMatchObject({ enabled: true, blockedCountries: [] });
  });

  it('rejects out of range and duplicate-currency input', async () => {
    expect((await putConfig({ reserveTimeoutSeconds: 5 })).status).toBe(400);
    expect((await putConfig({ sessionTtlMinutes: 99_999 })).status).toBe(400);
    expect(
      (
        await putConfig({
          currencies: [
            { currency: 'USD', decimals: 2 },
            { currency: 'USD', decimals: 2 },
          ],
        })
      ).status,
    ).toBe(400);
  });

  it('refuses a plain player and an anonymous caller writing the config', async () => {
    const before = await auditCount('sportsbook.config.set');
    const body = JSON.stringify({
      enabled: false,
      currencies: [],
      blockedCountries: [],
      reserveTimeoutSeconds: 30,
      settlementGraceMinutes: 10,
      sessionTtlMinutes: 60,
    });
    const headers = { 'content-type': 'application/json' };
    expect(
      (await stranger.request('/backoffice/sportsbook/config', { method: 'PUT', headers, body }))
        .status,
    ).toBe(403);
    expect(
      (await anonymous('/backoffice/sportsbook/config', { method: 'PUT', headers, body })).status,
    ).toBe(401);
    expect((await getConfig()).enabled).toBe(true);
    expect(await auditCount('sportsbook.config.set')).toBe(before);
  });
});

describe('sportsbook suspend and resume routes', () => {
  afterEach(async () => {
    await admin.post('/backoffice/sportsbook/resume', { reason: 'test cleanup' });
  });

  it('suspends with an audited reason, refuses new reserves, still settles, and resumes', async () => {
    const player = await fundedPlayer(app, '100');
    const { args } = await acceptedBet(app, player, { stake: '10', potentialPayout: '25' });
    const suspendedBefore = await auditCount('sportsbook.config.suspended');
    const resumedBefore = await auditCount('sportsbook.config.resumed');

    const suspend = await admin.post('/backoffice/sportsbook/suspend', {
      reason: 'provider incident 42',
    });
    expect(suspend.status).toBe(200);
    expect((await json<Config>(suspend)).suspended).toBe(true);
    expect((await getConfig()).suspended).toBe(true);
    const suspendRows = await auditRows('sportsbook.config.suspended');
    expect(suspendRows).toHaveLength(suspendedBefore + 1);
    expect(suspendRows[0]).toMatchObject({ actorType: 'admin' });
    expect(suspendRows[0]!.after).toMatchObject({
      suspended: true,
      reason: 'provider incident 42',
    });

    expect(await ledgerOf(app).reserve(reserveArgs(player.sessionId))).toEqual({
      status: 'refused',
      reason: 'suspended',
    });
    expect(await balanceOf(app, player.userId)).toBe(money(90));

    const settled = expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: args.providerBetId,
        result: 'won',
        payout: '25',
      }),
    );
    expect(settled.betStatus).toBe('settled');
    expect(await balanceOf(app, player.userId)).toBe(money(115));

    const again = await admin.post('/backoffice/sportsbook/suspend', { reason: 'still suspended' });
    expect(again.status).toBe(200);
    expect(await auditCount('sportsbook.config.suspended')).toBe(suspendedBefore + 1);

    const resume = await admin.post('/backoffice/sportsbook/resume', { reason: 'incident closed' });
    expect(resume.status).toBe(200);
    expect((await json<Config>(resume)).suspended).toBe(false);
    const resumeRows = await auditRows('sportsbook.config.resumed');
    expect(resumeRows).toHaveLength(resumedBefore + 1);
    expect(resumeRows[0]!.after).toMatchObject({ suspended: false, reason: 'incident closed' });

    expectApplied(await ledgerOf(app).reserve(reserveArgs(player.sessionId)));
    expect(await balanceOf(app, player.userId)).toBe(money(105));
  });

  it('requires a reason', async () => {
    expect((await admin.post('/backoffice/sportsbook/suspend', {})).status).toBe(400);
    expect((await admin.post('/backoffice/sportsbook/suspend', { reason: '' })).status).toBe(400);
    expect((await admin.post('/backoffice/sportsbook/resume', { reason: '' })).status).toBe(400);
    expect((await getConfig()).suspended).toBe(false);
  });

  it('refuses a plain player and an anonymous caller', async () => {
    const before = await auditCount('sportsbook.config.suspended');
    expect((await stranger.post('/backoffice/sportsbook/suspend', { reason: 'nope' })).status).toBe(
      403,
    );
    expect((await stranger.post('/backoffice/sportsbook/resume', { reason: 'nope' })).status).toBe(
      403,
    );
    expect(
      (
        await anonymous('/backoffice/sportsbook/suspend', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'nope' }),
        })
      ).status,
    ).toBe(401);
    expect((await getConfig()).suspended).toBe(false);
    expect(await auditCount('sportsbook.config.suspended')).toBe(before);
  });
});

describe('sportsbook player restriction routes', () => {
  it('restricts a player, revokes their live sessions, audits the reason and blocks the next reserve', async () => {
    const player = await fundedPlayer(app, '100');
    const path = `/backoffice/sportsbook/players/${player.userId}/restriction`;

    const res = await admin.post(path, { reason: 'self-exclusion request' });
    expect(res.status).toBe(200);
    expect(await json<{ restricted: boolean; reason: string }>(res)).toMatchObject({
      userId: player.userId,
      restricted: true,
      reason: 'self-exclusion request',
    });
    expect(mockSportsbookProviderState.revoked).toEqual([player.sessionId]);

    const rows = await auditRows('sportsbook.restriction.changed', player.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'admin' });
    expect(rows[0]!.after).toMatchObject({
      restricted: true,
      changeReason: 'self-exclusion request',
      revokedSessions: 1,
    });

    expect(await ledgerOf(app).reserve(reserveArgs(player.sessionId))).toEqual({
      status: 'refused',
      reason: 'session_invalid',
    });
    expect(await balanceOf(app, player.userId)).toBe(money(100));

    const restrictedBy = async () => {
      const [row] = await app.container
        .get(DRIZZLE)
        .db.select({ restrictedBy: sportsbookPlayerRestriction.restrictedBy })
        .from(sportsbookPlayerRestriction)
        .where(eq(sportsbookPlayerRestriction.userId, player.userId));
      return row?.restrictedBy;
    };
    const firstBy = await restrictedBy();
    const repeat = await (
      await sportsbookManager()
    ).post(path, {
      reason: 'self-exclusion request',
    });
    expect(repeat.status).toBe(200);
    expect(await restrictedBy()).toBe(firstBy);
    expect(await auditRows('sportsbook.restriction.changed', player.userId)).toHaveLength(1);
  });

  it('lifts a restriction with an audited reason and the player can bet on a new session', async () => {
    const player = await fundedPlayer(app, '100');
    const path = `/backoffice/sportsbook/players/${player.userId}/restriction`;
    await admin.post(path, { reason: 'review' });

    const lifted = await del(admin, path, { userId: player.userId, reason: 'review passed' });
    expect(lifted.status).toBe(200);
    expect(await json<{ restricted: boolean; reason: string | null }>(lifted)).toMatchObject({
      userId: player.userId,
      restricted: false,
      reason: null,
    });

    const rows = await auditRows('sportsbook.restriction.changed', player.userId);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.after).toMatchObject({ restricted: false, changeReason: 'review passed' });

    const session = await openSession(player.client);
    expect(session.status).toBe(200);
    const { sessionId } = await json<{ sessionId: string }>(session);
    expectApplied(await ledgerOf(app).reserve(reserveArgs(sessionId)));
    expect(await balanceOf(app, player.userId)).toBe(money(90));
  });

  it('answers 404 for an unknown player and 400 for a missing reason', async () => {
    const unknown = randomUUID();
    expect(
      (await admin.post(`/backoffice/sportsbook/players/${unknown}/restriction`, { reason: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (
        await del(admin, `/backoffice/sportsbook/players/${unknown}/restriction`, {
          userId: unknown,
          reason: 'x',
        })
      ).status,
    ).toBe(404);

    const { userId } = await registerAndMaterializePlayer(app, {
      email: `sportsbook-${randomUUID()}@example.com`,
    });
    const path = `/backoffice/sportsbook/players/${userId}/restriction`;
    expect((await admin.post(path, {})).status).toBe(400);
    expect((await admin.post(path, { reason: '' })).status).toBe(400);
    expect(await auditRows('sportsbook.restriction.changed', userId)).toHaveLength(0);
  });

  it('refuses a plain player and an anonymous caller, in either direction', async () => {
    const victim = await fundedPlayer(app, '100');
    const path = `/backoffice/sportsbook/players/${victim.userId}/restriction`;
    expect((await victim.client.post(path, { reason: 'self' })).status).toBe(403);
    expect((await stranger.post(path, { reason: 'other' })).status).toBe(403);
    expect(
      (
        await anonymous(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'x' }),
        })
      ).status,
    ).toBe(401);

    await admin.post(path, { reason: 'real restriction' });
    expect(
      (await del(stranger, path, { userId: victim.userId, reason: 'sneaky lift' })).status,
    ).toBe(403);
    expect(
      (await del(victim.client, path, { userId: victim.userId, reason: 'self lift' })).status,
    ).toBe(403);
    expect((await openSession(victim.client)).status).toBe(403);
  });
});

describe('sportsbook findings routes', () => {
  it('lists a fingerprint mismatch finding and resolves it once with an audited note', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const betId = expectApplied(await ledgerOf(app).reserve(args)).betId!;
    expect(await ledgerOf(app).reserve({ ...args, stake: '11' })).toEqual({
      status: 'refused',
      reason: 'fingerprint_mismatch',
    });

    const listed = await admin.get(
      '/backoffice/sportsbook/findings?kind=fingerprint_mismatch&status=open&limit=100',
    );
    expect(listed.status).toBe(200);
    const finding = (await json<Page<Finding>>(listed)).items.find((f) => f.betId === betId);
    expect(finding).toMatchObject({
      kind: 'fingerprint_mismatch',
      status: 'open',
      userId: player.userId,
      resolvedBy: null,
    });

    const path = `/backoffice/sportsbook/findings/${finding!.id}/resolve`;
    const resolved = await admin.post(path, { note: 'provider retried with a corrected stake' });
    expect(resolved.status).toBe(200);
    const resolvedBody = await json<Finding>(resolved);
    expect(resolvedBody).toMatchObject({
      id: finding!.id,
      status: 'resolved',
      resolutionNote: 'provider retried with a corrected stake',
    });
    expect(resolvedBody.resolvedBy).toBeTruthy();

    const rows = await auditRows('sportsbook.finding.resolved', finding!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: 'admin' });

    const open = await findingsFor('kind=fingerprint_mismatch&status=open&limit=100');
    expect(open.map((f) => f.id)).not.toContain(finding!.id);
    const done = await findingsFor('kind=fingerprint_mismatch&status=resolved&limit=100');
    expect(done.map((f) => f.id)).toContain(finding!.id);

    expect(await conflictReason(await admin.post(path, { note: 'again' }))).toBe(
      'finding_resolved',
    );
    expect(await auditRows('sportsbook.finding.resolved', finding!.id)).toHaveLength(1);
  });

  it('answers 404 for an unknown finding and 400 for a missing note or bad filter', async () => {
    expect(
      (await admin.post(`/backoffice/sportsbook/findings/${randomUUID()}/resolve`, { note: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await admin.post(`/backoffice/sportsbook/findings/${randomUUID()}/resolve`, {})).status,
    ).toBe(400);
    expect((await admin.get('/backoffice/sportsbook/findings?kind=bogus')).status).toBe(400);
  });

  it('refuses a plain player and an anonymous caller', async () => {
    const player = await fundedPlayer(app, '100');
    const args = reserveArgs(player.sessionId);
    const betId = expectApplied(await ledgerOf(app).reserve(args)).betId!;
    await ledgerOf(app).reserve({ ...args, stake: '12' });
    const finding = (await findingsFor('kind=fingerprint_mismatch&status=open&limit=100')).find(
      (f) => f.betId === betId,
    )!;

    expect((await player.client.get('/backoffice/sportsbook/findings')).status).toBe(403);
    expect((await anonymous('/backoffice/sportsbook/findings')).status).toBe(401);
    expect(
      (
        await player.client.post(`/backoffice/sportsbook/findings/${finding.id}/resolve`, {
          note: 'self-service',
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await (
          await sportsbookManager()
        ).post(`/backoffice/sportsbook/findings/${finding.id}/resolve`, {
          note: 'without refund rights',
        })
      ).status,
    ).toBe(403);
    expect(
      (await findingsFor('kind=fingerprint_mismatch&status=open&limit=100')).map((f) => f.id),
    ).toContain(finding.id);
  });
});

describe('sportsbook debt routes', () => {
  it('refuses a withdrawal while the debt hold is active and moves nothing', async () => {
    const { player } = await playerInDebt();
    await deposit(player.client, '20');
    const withdrawal = await player.client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '10',
      currency: 'USD',
    });
    expect(await conflictReason(withdrawal)).toBe('withdrawal_held');
    expect(await balanceOf(app, player.userId)).toBe(money(20));
  });

  it('lists a debt with the withdrawal hold active and filters by status and player', async () => {
    const { player, debt } = await playerInDebt();
    expect(debt).toMatchObject({
      userId: player.userId,
      currency: 'USD',
      owed: money(40),
      collected: money(0),
      outstanding: money(40),
      status: 'open',
      holdActive: true,
    });

    const open = await json<Page<Debt>>(
      await admin.get('/backoffice/sportsbook/debts?status=open&limit=100'),
    );
    expect(open.items.map((d) => d.id)).toContain(debt.id);
    const written = await json<Page<Debt>>(
      await admin.get(`/backoffice/sportsbook/debts?status=written_off&userId=${player.userId}`),
    );
    expect(written.items).toHaveLength(0);
    expect((await admin.get('/backoffice/sportsbook/debts?status=bogus')).status).toBe(400);

    const recorded = await findingsFor('kind=debt_recorded&limit=100');
    expect(recorded.some((f) => f.userId === player.userId)).toBe(true);
  });

  it('refuses to list debts for a plain player or an anonymous caller', async () => {
    expect((await stranger.get('/backoffice/sportsbook/debts')).status).toBe(403);
    expect((await anonymous('/backoffice/sportsbook/debts')).status).toBe(401);
  });

  it('collects what the balance holds, keeps the hold until cleared, and refuses a cleared debt', async () => {
    const { player, debt } = await playerInDebt();
    const path = `/backoffice/sportsbook/debts/${debt.id}/collect`;

    expect(await conflictReason(await admin.post(path, { idempotencyKey: randomUUID() }))).toBe(
      'nothing_collected',
    );
    expect((await debtOf(player.userId)).outstanding).toBe(money(40));

    await deposit(player.client, '15');
    const partial = await admin.post(path, { idempotencyKey: randomUUID() });
    expect(partial.status).toBe(200);
    expect(await json<Debt>(partial)).toMatchObject({
      id: debt.id,
      collected: money(15),
      outstanding: money(25),
      status: 'open',
      holdActive: true,
    });
    expect(await balanceOf(app, player.userId)).toBe(money(0));

    await deposit(player.client, '100');
    const full = await admin.post(path, { idempotencyKey: randomUUID() });
    expect(full.status).toBe(200);
    expect(await json<Debt>(full)).toMatchObject({
      id: debt.id,
      collected: money(40),
      outstanding: money(0),
      status: 'cleared',
      holdActive: false,
    });
    expect(await balanceOf(app, player.userId)).toBe(money(75));
    expect(await debtOf(player.userId)).toMatchObject({ status: 'cleared' });

    const rows = await auditRows('sportsbook.debt.changed', debt.id);
    const collected = rows.filter((r) => (r.after as { cause?: string }).cause === 'collected');
    expect(collected).toHaveLength(2);
    expect(collected[0]).toMatchObject({ actorType: 'admin' });

    expect(await conflictReason(await admin.post(path, { idempotencyKey: randomUUID() }))).toBe(
      'debt_cleared',
    );
    expect(await balanceOf(app, player.userId)).toBe(money(75));
  });

  it("collects each shortfall oldest first into the round that owes it, as that round's leg type", async () => {
    const { player, debt, wonBet } = await playerInDebt();
    await deposit(player.client, '20');
    const voided = await acceptedBet(app, player, { stake: '20', potentialPayout: '40' });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: voided.args.providerBetId,
        result: 'void',
        payout: '20',
      }),
    );
    await acceptedBet(app, player, { stake: '20', potentialPayout: '40' });
    expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: voided.args.providerBetId,
      }),
    );
    expect((await debtOf(player.userId)).outstanding).toBe(money(60));
    const path = `/backoffice/sportsbook/debts/${debt.id}/collect`;

    await deposit(player.client, '50');
    expect(
      await json<Debt>(await admin.post(path, { idempotencyKey: randomUUID() })),
    ).toMatchObject({
      collected: money(50),
      outstanding: money(10),
    });
    await deposit(player.client, '100');
    expect(
      await json<Debt>(await admin.post(path, { idempotencyKey: randomUUID() })),
    ).toMatchObject({
      collected: money(60),
      outstanding: money(0),
    });

    const legs = await app.container
      .get(DRIZZLE)
      .db.select({
        providerName: walletTransaction.providerName,
        externalRoundId: walletTransaction.externalRoundId,
        type: walletTransaction.type,
        direction: walletTransaction.direction,
        amount: walletTransaction.amount,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(eq(wallet.userId, player.userId), like(walletTransaction.providerRefId, 'collect:%')),
      )
      .orderBy(asc(walletTransaction.createdAt), desc(walletTransaction.amount));
    const leg = { providerName: `sportsbook:${PROVIDER}`, direction: 'debit' };
    expect(legs).toEqual([
      { ...leg, externalRoundId: wonBet.providerBetId, type: 'win_reversal', amount: money(40) },
      { ...leg, externalRoundId: voided.args.providerBetId, type: 'bet', amount: money(10) },
      { ...leg, externalRoundId: voided.args.providerBetId, type: 'bet', amount: money(10) },
    ]);
  });

  it('offsets a reopened void back as its stake, in the round that owed it', async () => {
    const player = await fundedPlayer(app, '10');
    const limit = await admin.put(`/compliance/players/${player.userId}/limits`, {
      type: 'wager',
      amount: '1000',
      minutes: null,
      currency: 'USD',
      period: 'daily',
      reason: 'wager limit for the offset check',
      confirm: true,
    });
    expect(limit.status).toBe(200);
    const voided = await acceptedBet(app, player, { stake: '10', potentialPayout: '20' });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: voided.args.providerBetId,
        result: 'void',
        payout: '10',
      }),
    );
    const withdrawal = await player.client.post('/wallet/withdraw', {
      idempotencyKey: randomUUID(),
      amount: '10',
      currency: 'USD',
    });
    expect(withdrawal.status).toBe(200);
    expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: voided.args.providerBetId,
      }),
    );
    expect((await debtOf(player.userId)).outstanding).toBe(money(10));

    await deposit(player.client, '5');
    const won = await acceptedBet(app, player, { stake: '5', potentialPayout: '25' });
    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: won.args.providerBetId,
        result: 'won',
        payout: '25',
      }),
    );

    expect((await debtOf(player.userId)).outstanding).toBe(money(0));
    const offsets = await app.container
      .get(DRIZZLE)
      .db.select({
        externalRoundId: walletTransaction.externalRoundId,
        type: walletTransaction.type,
        amount: walletTransaction.amount,
      })
      .from(walletTransaction)
      .innerJoin(wallet, eq(wallet.id, walletTransaction.walletId))
      .where(
        and(eq(wallet.userId, player.userId), like(walletTransaction.providerRefId, 'offset:%')),
      );
    expect(offsets).toEqual([
      { externalRoundId: voided.args.providerBetId, type: 'bet', amount: money(10) },
    ]);
    const limits = await json<{ type: string; used: string | null }[]>(
      await player.client.get('/compliance/limits'),
    );
    expect(limits.find((l) => l.type === 'wager')?.used).toBe(money(15));
  });

  it('refuses to collect for a plain player, the debtor included, and for an unknown debt', async () => {
    const { player, debt } = await playerInDebt();
    await deposit(player.client, '50');
    const path = `/backoffice/sportsbook/debts/${debt.id}/collect`;

    expect((await player.client.post(path, { idempotencyKey: randomUUID() })).status).toBe(403);
    expect((await stranger.post(path, { idempotencyKey: randomUUID() })).status).toBe(403);
    expect(
      (await (await sportsbookManager()).post(path, { idempotencyKey: randomUUID() })).status,
    ).toBe(403);
    expect(
      (
        await anonymous(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ idempotencyKey: randomUUID() }),
        })
      ).status,
    ).toBe(401);
    expect(await balanceOf(app, player.userId)).toBe(money(50));
    expect((await debtOf(player.userId)).outstanding).toBe(money(40));

    expect(
      (
        await admin.post(`/backoffice/sportsbook/debts/${randomUUID()}/collect`, {
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect((await admin.post('/backoffice/sportsbook/debts/not-a-uuid/collect')).status).toBe(400);
  });

  it('writes a debt off with an audited reason, releases the hold and refuses a second write-off', async () => {
    const { player, debt } = await playerInDebt();
    const path = `/backoffice/sportsbook/debts/${debt.id}/write-off`;

    const res = await admin.post(path, {
      reason: 'goodwill after provider error',
      idempotencyKey: randomUUID(),
    });
    expect(res.status).toBe(200);
    const body = await json<Debt>(res);
    expect(body).toMatchObject({
      id: debt.id,
      status: 'written_off',
      writtenOff: money(40),
      outstanding: money(0),
      holdActive: false,
      writtenOffReason: 'goodwill after provider error',
    });
    expect(body.writtenOffBy).toBeTruthy();
    expect(await debtOf(player.userId)).toMatchObject({ status: 'written_off' });

    const rows = (await auditRows('sportsbook.debt.changed', debt.id)).filter(
      (r) => (r.after as { cause?: string }).cause === 'written_off',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.after).toMatchObject({ reason: 'goodwill after provider error' });

    expect(
      await conflictReason(
        await admin.post(path, { reason: 'again', idempotencyKey: randomUUID() }),
      ),
    ).toBe('debt_cleared');
    expect(
      await conflictReason(
        await admin.post(`/backoffice/sportsbook/debts/${debt.id}/collect`, {
          idempotencyKey: randomUUID(),
        }),
      ),
    ).toBe('debt_cleared');
  });

  it('answers a retried collect from its first answer and takes nothing deposited since', async () => {
    const { player, debt } = await playerInDebt();
    const path = `/backoffice/sportsbook/debts/${debt.id}/collect`;
    const request = { idempotencyKey: randomUUID() };
    await deposit(player.client, '15');
    const first = await json<Debt>(await admin.post(path, request));
    expect(first).toMatchObject({ collected: money(15), outstanding: money(25) });

    await deposit(player.client, '100');
    const again = await admin.post(path, request);
    expect(again.status).toBe(200);
    expect(await json<Debt>(again)).toEqual(first);
    expect(await balanceOf(app, player.userId)).toBe(money(100));
    expect((await debtOf(player.userId)).outstanding).toBe(money(25));
    const collected = (await auditRows('sportsbook.debt.changed', debt.id)).filter(
      (r) => (r.after as { cause?: string }).cause === 'collected',
    );
    expect(collected).toHaveLength(1);
  });

  it('answers a retried write-off from its first answer and forgives no debt added since', async () => {
    const { player, debt, pendingBet } = await playerInDebt();
    const path = `/backoffice/sportsbook/debts/${debt.id}/write-off`;
    const request = { reason: 'goodwill', idempotencyKey: randomUUID() };
    const first = await json<Debt>(await admin.post(path, request));
    expect(first).toMatchObject({ status: 'written_off', outstanding: money(0) });

    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: pendingBet.providerBetId,
        result: 'won',
        payout: '30',
      }),
    );
    await acceptedBet(app, player, { stake: '30', potentialPayout: '60' });
    expect(await balanceOf(app, player.userId)).toBe(money(0));
    expectApplied(
      await ledgerOf(app).reopen({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: pendingBet.providerBetId,
      }),
    );
    expect((await debtOf(player.userId)).outstanding).toBe(money(30));

    const again = await admin.post(path, request);
    expect(again.status).toBe(200);
    expect(await json<Debt>(again)).toEqual(first);
    expect(await debtOf(player.userId)).toMatchObject({ outstanding: money(30), holdActive: true });
  });

  it('refuses an idempotency key reused for another debt request', async () => {
    const { debt } = await playerInDebt();
    const idempotencyKey = randomUUID();
    const base = `/backoffice/sportsbook/debts/${debt.id}`;
    expect(
      (await admin.post(`${base}/write-off`, { reason: 'goodwill', idempotencyKey })).status,
    ).toBe(200);
    expect(
      await conflictReason(
        await admin.post(`${base}/write-off`, { reason: 'other', idempotencyKey }),
      ),
    ).toBe('idempotency_key_reused');
    expect(await conflictReason(await admin.post(`${base}/collect`, { idempotencyKey }))).toBe(
      'idempotency_key_reused',
    );
    const other = await playerInDebt();
    expect(
      await conflictReason(
        await admin.post(`/backoffice/sportsbook/debts/${other.debt.id}/collect`, {
          idempotencyKey,
        }),
      ),
    ).toBe('idempotency_key_reused');
    expect((await debtOf(other.player.userId)).outstanding).toBe(money(40));
  });

  it.each(['collect', 'write-off'] as const)(
    'answers one %s and refuses the other when two debts race on one key',
    async (action) => {
      const debtors = await Promise.all([playerInDebt(), playerInDebt()]);
      await Promise.all(debtors.map(({ player }) => deposit(player.client, '30')));
      const idempotencyKey = randomUUID();
      const body =
        action === 'collect' ? { idempotencyKey } : { reason: 'goodwill', idempotencyKey };
      const responses = await Promise.all(
        debtors.map(({ debt }) =>
          admin.post(`/backoffice/sportsbook/debts/${debt.id}/${action}`, body),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
      const loser = responses.findIndex((r) => r.status === 409);
      expect(await conflictReason(responses[loser]!)).toBe('idempotency_key_reused');
      const { player } = debtors[loser]!;
      expect((await debtOf(player.userId)).outstanding).toBe(money(40));
      expect(await balanceOf(app, player.userId)).toBe(money(30));
    },
  );

  it('refuses a write-off without a reason, for an unknown debt, and for a plain player', async () => {
    const { player, debt } = await playerInDebt();
    const path = `/backoffice/sportsbook/debts/${debt.id}/write-off`;

    expect((await admin.post(path, {})).status).toBe(400);
    expect((await admin.post(path, { reason: '', idempotencyKey: randomUUID() })).status).toBe(400);
    expect(
      (
        await admin.post(`/backoffice/sportsbook/debts/${randomUUID()}/write-off`, {
          reason: 'x',
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(404);
    expect(
      (await player.client.post(path, { reason: 'forgive me', idempotencyKey: randomUUID() }))
        .status,
    ).toBe(403);
    expect(
      (await stranger.post(path, { reason: 'forgive them', idempotencyKey: randomUUID() })).status,
    ).toBe(403);
    expect(
      (
        await (
          await sportsbookManager()
        ).post(path, { reason: 'without refund rights', idempotencyKey: randomUUID() })
      ).status,
    ).toBe(403);
    expect(
      (
        await anonymous(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ reason: 'x', idempotencyKey: randomUUID() }),
        })
      ).status,
    ).toBe(401);
    expect(await debtOf(player.userId)).toMatchObject({
      status: 'open',
      outstanding: money(40),
      holdActive: true,
    });
  });

  it('lists no active hold for a cleared debt while another player still owes', async () => {
    const stillOwing = await playerInDebt();
    const cleared = await playerInDebt();
    const written = await admin.post(`/backoffice/sportsbook/debts/${cleared.debt.id}/write-off`, {
      reason: 'goodwill',
      idempotencyKey: randomUUID(),
    });
    expect((await json<Debt>(written)).holdActive).toBe(false);

    expect((await debtOf(stillOwing.player.userId)).holdActive).toBe(true);
    expect((await debtOf(cleared.player.userId)).holdActive).toBe(false);
  });

  it('offsets an open debt from the next payout so the hold lifts without a collect', async () => {
    const { player, debt, pendingBet } = await playerInDebt();

    expectApplied(
      await ledgerOf(app).settle({
        provider: PROVIDER,
        providerTxId: txId(),
        providerBetId: pendingBet.providerBetId,
        result: 'won',
        payout: '200',
      }),
    );

    expect(await balanceOf(app, player.userId)).toBe(money(160));
    expect(await debtOf(player.userId)).toMatchObject({
      id: debt.id,
      collected: money(40),
      outstanding: money(0),
      status: 'cleared',
    });
    expect(
      (
        await admin.post(`/backoffice/sportsbook/debts/${debt.id}/collect`, {
          idempotencyKey: randomUUID(),
        })
      ).status,
    ).toBe(409);
  });
});
