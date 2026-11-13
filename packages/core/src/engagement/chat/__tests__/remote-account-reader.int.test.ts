import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { call } from '@orpc/server';
import { eq } from 'drizzle-orm';
import { ACCOUNT_READER_ROUTES, AccountReaderWire } from '@openora/core/contracts';
import type { InternalClient } from '@openora/core/server';
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

const CONTEXT = {
  request: { headers: {} as Record<string, string | string[] | undefined> },
  clientMeta: NO_CLIENT_META,
  internalCaller: 'chat',
};

/** The identity service's internal routes served in process, replies sent through JSON. */
function identityService(calls: string[] = []): InternalClient {
  const router = createInternalAccountsRouter(local);
  const byPath = new Map<string, (body: unknown) => Promise<unknown>>([
    [
      ACCOUNT_READER_ROUTES.accounts,
      (body) =>
        call(router.accounts, AccountReaderWire.accounts.input.parse(body), { context: CONTEXT }),
    ],
    [
      ACCOUNT_READER_ROUTES.byUsername,
      (body) =>
        call(router.byUsername, AccountReaderWire.byUsername.input.parse(body), {
          context: CONTEXT,
        }),
    ],
    [
      ACCOUNT_READER_ROUTES.search,
      (body) =>
        call(router.search, AccountReaderWire.search.input.parse(body), { context: CONTEXT }),
    ],
    [
      ACCOUNT_READER_ROUTES.byPlayer,
      (body) =>
        call(router.byPlayer, AccountReaderWire.byPlayer.input.parse(body), { context: CONTEXT }),
    ],
  ]);
  return {
    async request(_method, path, body) {
      calls.push(path);
      const route = byPath.get(path);
      if (!route) {
        throw new Error(`no route ${path}`);
      }
      return JSON.parse(JSON.stringify(await route(body)));
    },
  };
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile]);
  local = new DrizzleAccountReader(db.drizzle);
});

afterAll(async () => {
  await db.drop();
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

  it('serves an account from cache until the TTL passes, then reads it again', async () => {
    const seeded = await seedPlayerWithUser(db);
    const calls: string[] = [];
    let now = 1_000;
    const remote = new RemoteAccountReader(identityService(calls), () => now);

    await remote.getAccounts([seeded.account.id]);
    await db.drizzle.db
      .update(player)
      .set({ status: 'closed' })
      .where(eq(player.id, seeded.player.id));
    now += ACCOUNT_CACHE_TTL_MS - 1;
    const cached = await remote.getAccounts([seeded.account.id]);
    now += 2;
    const fresh = await remote.getAccounts([seeded.account.id]);

    expect(calls).toHaveLength(2);
    expect(cached.get(seeded.account.id)?.player?.status).toBe('active');
    expect(fresh.get(seeded.account.id)?.player?.status).toBe('closed');
    expect(fresh.get(seeded.account.id)?.playRefusal).not.toBeNull();
  });

  it('asks again for an id the identity service did not know', async () => {
    const calls: string[] = [];
    const remote = new RemoteAccountReader(identityService(calls));

    const unknownId = randomUUID();
    await remote.getAccounts([unknownId]);
    await remote.getAccounts([unknownId]);

    expect(calls).toHaveLength(2);
  });

  it('throws instead of answering while the identity service is down', async () => {
    const remote = new RemoteAccountReader({
      request: () => Promise.reject(new TypeError('fetch failed')),
    });

    await expect(remote.getAccounts([randomUUID()])).rejects.toThrow('fetch failed');
    await expect(remote.findPlayerByUsername('anyone')).rejects.toThrow('fetch failed');
  });

  it('rejects a reply that does not match the wire schema', async () => {
    const remote = new RemoteAccountReader({
      request: () => Promise.resolve({ accounts: [{ userId: 'x' }] }),
    });

    await expect(remote.getAccounts([randomUUID()])).rejects.toThrow();
  });
});
