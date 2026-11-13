import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call, ORPCError } from '@orpc/server';
import { eq } from 'drizzle-orm';
import {
  ACCOUNT_READER_ROUTES,
  ACCOUNTS_BATCH_MAX,
  AccountReaderWire,
} from '@openora/core/contracts';
import {
  createInternalClient,
  InternalApiError,
  upstreamDownAs503,
  type InternalClient,
} from '@openora/core/server';
import {
  createTestDb,
  seedPlayerWithUser,
  seedUser,
  uniqueUsername,
  type TestDb,
} from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { createInternalAccountsRouter, DrizzleAccountReader } from '@openora/core/pam/server';
import { NO_CLIENT_META } from '../../../testing/mock.js';
import {
  ACCOUNT_CACHE_TTL_MS,
  RemoteAccountReader,
} from '../service/remote-account-reader.service.js';

let db: TestDb;
let local: DrizzleAccountReader;

const contextFor = (internalCaller: string) => ({
  request: { headers: {} as Record<string, string | string[] | undefined> },
  clientMeta: NO_CLIENT_META,
  internalCaller,
});

type Traffic = { paths: string[]; inFlight: number; maxInFlight: number };
const traffic = (): Traffic => ({ paths: [], inFlight: 0, maxInFlight: 0 });

/** The identity service's internal routes served in process, replies sent through JSON. */
function identityService(seen: Traffic = traffic(), caller = 'chat'): InternalClient {
  const router = createInternalAccountsRouter(local, new Set(['chat']));
  const context = contextFor(caller);
  const byPath = new Map<string, (body: unknown) => Promise<unknown>>([
    [
      ACCOUNT_READER_ROUTES.accounts,
      (body) => call(router.accounts, AccountReaderWire.accounts.input.parse(body), { context }),
    ],
    [
      ACCOUNT_READER_ROUTES.byUsername,
      (body) =>
        call(router.byUsername, AccountReaderWire.byUsername.input.parse(body), { context }),
    ],
    [
      ACCOUNT_READER_ROUTES.search,
      (body) => call(router.search, AccountReaderWire.search.input.parse(body), { context }),
    ],
    [
      ACCOUNT_READER_ROUTES.byPlayer,
      (body) => call(router.byPlayer, AccountReaderWire.byPlayer.input.parse(body), { context }),
    ],
  ]);
  return {
    async request(_method, path, body) {
      seen.paths.push(path);
      const route = byPath.get(path);
      if (!route) {
        throw new Error(`no route ${path}`);
      }
      seen.inFlight += 1;
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
      try {
        return JSON.parse(JSON.stringify(await route(body)));
      } finally {
        seen.inFlight -= 1;
      }
    },
  };
}

/** A real signed client whose network is `fetch`, timing out after 20ms. */
function overNetwork(fetch: (url: URL, init: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', fetch);
  return new RemoteAccountReader(
    createInternalClient({
      baseUrl: 'http://identity.test',
      serviceName: 'chat',
      audience: 'identity',
      secrets: 'x'.repeat(32),
      timeoutMs: 20,
    }),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile]);
  local = new DrizzleAccountReader(db.drizzle);
});

afterAll(async () => {
  await db.drop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RemoteAccountReader', () => {
  it('answers every read as the local reader does', async () => {
    const prefix = uniqueUsername('par');
    const active = await seedPlayerWithUser(db, { username: `${prefix}_active` });
    const closed = await seedPlayerWithUser(db, {
      username: `${prefix}_closed`,
      status: 'closed',
    });
    const staff = await seedUser(db, { username: `${prefix}_staff`, role: 'admin' });
    const unknownId = randomUUID();
    const remote = new RemoteAccountReader(identityService());

    const ids = [active.account.id, closed.account.id, staff.id, unknownId];
    expect(await remote.getAccounts(ids)).toEqual(await local.getAccounts(ids));
    expect((await remote.getAccounts([unknownId])).has(unknownId)).toBe(false);
    for (const username of [active.account.username.toUpperCase(), staff.username, 'nobody']) {
      expect(await remote.findPlayerByUsername(username)).toEqual(
        await local.findPlayerByUsername(username),
      );
    }
    const search = { query: prefix, excludeUserId: active.account.id, limit: 10 };
    expect(await remote.searchPlayers(search)).toEqual(await local.searchPlayers(search));
    for (const playerId of [active.player.id, randomUUID()]) {
      expect(await remote.findUserIdByPlayerId(playerId)).toEqual(
        await local.findUserIdByPlayerId(playerId),
      );
    }
  });

  it('sends no status, activity or exclusion reason on the player lookups', async () => {
    const seeded = await seedPlayerWithUser(db, { status: 'self_excluded' });
    const remote = new RemoteAccountReader(identityService());

    const found = await remote.findPlayerByUsername(seeded.account.username);
    const listed = await remote.searchPlayers({
      query: seeded.account.username,
      excludeUserId: randomUUID(),
      limit: 5,
    });

    expect(Object.keys(found ?? {}).sort()).toEqual(['avatarUrl', 'userId', 'username']);
    expect(listed.flatMap((match) => Object.keys(match)).sort()).toEqual([
      'avatarUrl',
      'userId',
      'username',
    ]);
    const account = (await remote.getAccounts([seeded.account.id])).get(seeded.account.id);
    expect(account).toMatchObject({ excluded: true, player: { closed: false } });
    expect(JSON.stringify(account)).not.toContain('self_excluded');
  });

  it('finds an account by an id written in upper case, and caches it under either case', async () => {
    const seeded = await seedPlayerWithUser(db);
    const seen = traffic();
    const remote = new RemoteAccountReader(identityService(seen));
    const shouted = seeded.account.id.toUpperCase();

    const byShouted = await remote.getAccounts([shouted]);
    const byPlain = await remote.getAccounts([seeded.account.id]);

    expect(byShouted.get(shouted)?.userId).toBe(seeded.account.id);
    expect(byPlain.get(seeded.account.id)?.userId).toBe(seeded.account.id);
    expect((await local.getAccounts([shouted])).get(shouted)?.userId).toBe(seeded.account.id);
    expect(seen.paths).toHaveLength(1);
  });

  it('serves an account from cache until the TTL passes, then reads it again', async () => {
    const seeded = await seedPlayerWithUser(db);
    const seen = traffic();
    let now = 1_000;
    const remote = new RemoteAccountReader(identityService(seen), () => now);

    await remote.getAccounts([seeded.account.id]);
    await db.drizzle.db
      .update(player)
      .set({ status: 'closed' })
      .where(eq(player.id, seeded.player.id));
    now += ACCOUNT_CACHE_TTL_MS - 1;
    const cached = await remote.getAccounts([seeded.account.id]);
    now += 2;
    const reread = await remote.getAccounts([seeded.account.id]);

    expect(seen.paths).toHaveLength(2);
    expect(cached.get(seeded.account.id)?.player?.closed).toBe(false);
    expect(reread.get(seeded.account.id)?.player?.closed).toBe(true);
    expect(reread.get(seeded.account.id)?.excluded).toBe(true);
  });

  it('skips the cache on a fresh read', async () => {
    const seeded = await seedPlayerWithUser(db);
    const seen = traffic();
    const remote = new RemoteAccountReader(identityService(seen));

    await remote.getAccounts([seeded.account.id]);
    await db.drizzle.db
      .update(player)
      .set({ status: 'suspended' })
      .where(eq(player.id, seeded.player.id));
    const fresh = await remote.getAccounts([seeded.account.id], { fresh: true });

    expect(seen.paths).toHaveLength(2);
    expect(fresh.get(seeded.account.id)?.player?.closed).toBe(true);
  });

  it('splits a read over the batch limit and runs at most four batches at once', async () => {
    const seeded = await seedPlayerWithUser(db);
    const seen = traffic();
    const remote = new RemoteAccountReader(identityService(seen));
    const ids = [
      ...Array.from({ length: ACCOUNTS_BATCH_MAX * 5 }, () => randomUUID()),
      seeded.account.id,
    ];

    const accounts = await remote.getAccounts(ids);

    expect(seen.paths).toHaveLength(6);
    expect(seen.maxInFlight).toBe(4);
    expect([...accounts.keys()]).toEqual([seeded.account.id]);
  });

  it('asks again for an id the identity service did not know', async () => {
    const seen = traffic();
    const remote = new RemoteAccountReader(identityService(seen));

    const unknownId = randomUUID();
    await remote.getAccounts([unknownId]);
    await remote.getAccounts([unknownId]);

    expect(seen.paths).toHaveLength(2);
  });

  it('refuses a service the identity service does not list as a caller', async () => {
    const remote = new RemoteAccountReader(identityService(traffic(), 'wallet'));

    await expect(remote.getAccounts([randomUUID()])).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(remote.findPlayerByUsername('anyone')).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('throws instead of answering while the identity service is down', async () => {
    const remote = new RemoteAccountReader({
      request: () => Promise.reject(new TypeError('fetch failed')),
    });

    await expect(remote.getAccounts([randomUUID()])).rejects.toThrow('fetch failed');
    await expect(remote.findPlayerByUsername('anyone')).rejects.toThrow('fetch failed');
  });

  it('gives up on a stalled identity call at the timeout', async () => {
    const remote = overNetwork(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );

    const failure = await remote.getAccounts([randomUUID()]).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(InternalApiError);
    expect(failure).toMatchObject({ kind: 'timeout' });
    expect(upstreamDownAs503(failure)).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
  });

  it('answers 503 for an identity 5xx and leaves a refused 4xx a server error', async () => {
    const down = overNetwork(async () => new Response('{}', { status: 502 }));
    const downFailure = await down.getAccounts([randomUUID()]).catch((err: unknown) => err);
    const refused = overNetwork(async () => new Response('{}', { status: 400 }));
    const refusedFailure = await refused.getAccounts([randomUUID()]).catch((err: unknown) => err);

    expect(downFailure).toMatchObject({ kind: 'server', status: 502 });
    expect(upstreamDownAs503(downFailure)).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
    expect(refusedFailure).toMatchObject({ kind: 'client', status: 400 });
    expect(upstreamDownAs503(refusedFailure)).toBe(refusedFailure);
    expect(upstreamDownAs503(refusedFailure)).not.toBeInstanceOf(ORPCError);
  });

  it('rejects a reply that does not match the wire schema', async () => {
    const remote = new RemoteAccountReader({
      request: () => Promise.resolve({ accounts: [{ userId: 'x' }] }),
    });

    await expect(remote.getAccounts([randomUUID()])).rejects.toThrow();
  });
});
