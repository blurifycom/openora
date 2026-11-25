import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from 'drizzle-orm';
import { ORPCError } from '@orpc/server';
import { DRIZZLE, loadExtensions } from '@openora/core/server';
import {
  MONEY_PORTS_ROUTE,
  MONEY_REPORTING,
  PLAYER_RANK_READER,
  PLAY_ELIGIBILITY_PROJECTION,
  WALLET_COMMANDS,
  WALLET_READER,
} from '@openora/core/contracts';
import { bootTestApp, newPlayer, setupTestDb, type TestApp, type TestDb } from '../index.js';

// Two services on one database, as in the split before the database moves:
// `money` loads every module, `platform` sets MONEY_SERVICE_URL, so it drops the money modules
// and money-remote binds their ports to money's internal API. A call to the money origin is
// answered by the money app itself.
const MONEY_SERVICE_URL = 'http://money.internal';
const SECRETS = 'x'.repeat(32);

let db: TestDb;
let money: TestApp;
let platform: TestApp;
let mode: 'up' | 'down' | 'lose-one-reply' = 'up';
const moneyCalls: { path: string; caller: string | null; body: string }[] = [];
const realFetch = globalThis.fetch;

function withEnv<T>(env: Record<string, string>, run: () => Promise<T>): Promise<T> {
  const saved = Object.keys(env).map((key) => [key, process.env[key]] as const);
  Object.assign(process.env, env);
  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

beforeAll(async () => {
  process.env['BETTER_AUTH_SECRET'] ??= 'e2e-test-better-auth-secret-please-change-000000';
  process.env['AUTH_SECRET'] ??= process.env['BETTER_AUTH_SECRET'];
  process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ??= 'e2e-test-withdrawal-pin-hmac-secret-000000';
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(MONEY_SERVICE_URL)) {
      return realFetch(input, init);
    }
    const path = new URL(url).pathname;
    const body = typeof init?.body === 'string' ? init.body : '';
    moneyCalls.push({ path, caller: new Headers(init?.headers).get('x-openora-service'), body });
    if (mode === 'down') {
      throw new TypeError('fetch failed');
    }
    const reply = await money.app.request(path, {
      method: 'POST',
      headers: new Headers(init?.headers),
      body,
    });
    if (mode === 'lose-one-reply') {
      // Applied on the money side, but the reply never reaches the caller.
      mode = 'up';
      throw new TypeError('fetch failed');
    }
    return reply;
  });
  db = await setupTestDb();
  const shared = { INTERNAL_API_SECRETS: SECRETS, MONEY_PORTS_CALLERS: 'platform' };
  money = await withEnv(
    { ...shared, SERVICE_NAME: 'money', REALTIME_NAMESPACE: 'money-e2e' },
    async () => bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url }),
  );
  platform = await withEnv(
    { ...shared, SERVICE_NAME: 'platform', REALTIME_NAMESPACE: 'platform-e2e', MONEY_SERVICE_URL },
    async () => bootTestApp({ plugins: await loadExtensions(), databaseUrl: db.url }),
  );
}, 120_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  await platform?.close();
  await money?.close();
  await db?.dispose();
});

describe('a platform service with money-remote', () => {
  it('serves no money routes of its own', async () => {
    expect((await platform.app.request('/health')).status).toBe(200);
    expect((await platform.app.request('/wallet/balances')).status).toBe(404);
  });

  it('reads a wallet balance from the money service over the signed internal API', async () => {
    const player = await newPlayer(money, 'money-remote');
    await money.container.get(DRIZZLE).db.transaction((tx) =>
      money.container.get(WALLET_COMMANDS).credit(tx, {
        userId: player.userId,
        currency: 'USDT',
        amount: '300',
        type: 'deposit',
        allowNewWallet: true,
        allowNewCurrency: true,
        providerRef: { providerName: 'aggregator', providerRefId: randomUUID() },
      }),
    );
    moneyCalls.length = 0;

    const reading = await platform.container.get(WALLET_READER).getBalances(player.userId);

    expect(reading.balances).toContainEqual({
      currency: 'USDT',
      balance: expect.stringMatching(/^300(\.0+)?$/),
    });
    expect(moneyCalls).toEqual([
      expect.objectContaining({ path: `/internal/v1${MONEY_PORTS_ROUTE}`, caller: 'platform' }),
    ]);
  });

  it('keeps the platform modules that require money ports, served by the money service', async () => {
    // Required ports are checked at boot, so these resolving at all means money-remote binds them.
    expect((await platform.app.request('/compliance/country-rules')).status).not.toBe(404);
    const player = await newPlayer(money, 'money-remote-reporting');
    moneyCalls.length = 0;

    const activity = await platform.container.get(MONEY_REPORTING).funnelActivity([player.userId]);
    const rank = await platform.container.get(PLAYER_RANK_READER).getRankName(player.userId);

    expect(activity).toEqual({ deposited: [], placedBet: [] });
    expect(rank).toBe(await money.container.get(PLAYER_RANK_READER).getRankName(player.userId));
    expect(moneyCalls.map((call) => JSON.parse(call.body).port)).toEqual([
      'MONEY_REPORTING',
      'PLAYER_RANK_READER',
    ]);
  });

  it('retries a write whose reply was lost with the same key, and it applies once', async () => {
    const player = await newPlayer(money, 'money-remote-retry');
    const version = 1_000_000_000;
    moneyCalls.length = 0;
    mode = 'lose-one-reply';

    const written = await platform.container.get(PLAY_ELIGIBILITY_PROJECTION).reconcile([
      {
        userId: player.userId,
        rgBlocked: true,
        rgBlockedUntil: null,
        isActive: true,
        banned: false,
        banExpires: null,
        status: null,
        version,
      },
    ]);

    // The first attempt wrote the row; the retry found it at that version and wrote nothing.
    expect(written).toBe(0);
    expect(moneyCalls).toHaveLength(2);
    expect(moneyCalls[1]?.body).toBe(moneyCalls[0]?.body);
    expect(JSON.parse(moneyCalls[0]?.body ?? '{}')).toHaveProperty('idempotencyKey');
    const rows = await money.container
      .get(DRIZZLE)
      .db.execute<{ version: number; rg_blocked: boolean }>(
        sql`select version, rg_blocked from ledger_play_eligibility where user_id = ${player.userId}`,
      );
    expect(rows.rows).toEqual([{ version, rg_blocked: true }]);
  });

  it('fails closed with a 503 while the money service is down', async () => {
    mode = 'down';
    try {
      const err = await platform.container
        .get(WALLET_READER)
        .getBalances(randomUUID())
        .catch((caught: unknown) => caught);
      expect(err).toBeInstanceOf(ORPCError);
      expect((err as ORPCError<string, unknown>).code).toBe('SERVICE_UNAVAILABLE');
    } finally {
      mode = 'up';
    }
  });
});
