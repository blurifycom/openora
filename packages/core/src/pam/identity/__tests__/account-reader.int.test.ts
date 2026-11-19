import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { call } from '@orpc/server';
import type { PlayEligibilityPort } from '@openora/core/contracts';
import { randomUUID } from 'node:crypto';
import { createTestDb, seedPlayerWithUser, seedUser, type TestDb } from '@openora/core/testing';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate } from '../migrate.js';
import { createInternalAccountsRouter } from '../router/internal-accounts.router.js';
import { DrizzleAccountReader } from '../adapters/account-reader.service.js';
import { PlayEligibilityService } from '../service/play-eligibility.service.js';
import { NO_CLIENT_META } from '../../../testing/mock.js';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

const refusing = (...userIds: string[]): PlayEligibilityPort => ({
  isRestricted: async (userId) => userIds.includes(userId),
});

const ASK = { playEligibility: true } as const;

const routeContext = {
  context: { request: { headers: {} }, clientMeta: NO_CLIENT_META, internalCaller: 'chat' },
};

describe('DrizzleAccountReader excluded follows the bound play eligibility when asked', () => {
  it('marks an account a stricter binding refuses, and only that one', async () => {
    const refused = await seedPlayerWithUser(db);
    const allowed = await seedPlayerWithUser(db);
    const reader = new DrizzleAccountReader(db.drizzle, () => refusing(refused.account.id));

    const accounts = await reader.getAccounts([refused.account.id, allowed.account.id], ASK);

    expect(accounts.get(refused.account.id)?.excluded).toBe(true);
    expect(accounts.get(allowed.account.id)?.excluded).toBe(false);
  });

  it('keeps core refusals when the binding admits the account', async () => {
    const closed = await seedPlayerWithUser(db, { status: 'closed' });
    const reader = new DrizzleAccountReader(db.drizzle, () => refusing());

    const accounts = await reader.getAccounts([closed.account.id], ASK);

    expect(accounts.get(closed.account.id)?.excluded).toBe(true);
  });

  it('asks the binding only for player accounts core admits', async () => {
    const admitted = await seedPlayerWithUser(db);
    const closed = await seedPlayerWithUser(db, { status: 'closed' });
    const staff = await seedUser(db);
    const asked: string[] = [];
    const reader = new DrizzleAccountReader(db.drizzle, () => ({
      isRestricted: async (userId) => {
        asked.push(userId);
        return false;
      },
    }));

    await reader.getAccounts([admitted.account.id, closed.account.id, staff.id], ASK);

    expect(asked).toEqual([admitted.account.id]);
  });

  it('does not ask the binding on a read that does not set the option', async () => {
    const account = await seedPlayerWithUser(db);
    let asked = 0;
    const reader = new DrizzleAccountReader(db.drizzle, () => ({
      isRestricted: async () => {
        asked += 1;
        return true;
      },
    }));

    const accounts = await reader.getAccounts([account.account.id]);

    expect(accounts.get(account.account.id)?.excluded).toBe(false);
    expect(asked).toBe(0);
  });

  it('leaves searches and username lookups unaffected by a binding that throws', async () => {
    const account = await seedPlayerWithUser(db, {
      username: `lookup_${randomUUID().slice(0, 8)}`,
    });
    const reader = new DrizzleAccountReader(db.drizzle, () => ({
      isRestricted: async () => {
        throw new Error('overlay down');
      },
    }));

    await expect(reader.findPlayerByUsername(account.account.username!)).resolves.toMatchObject({
      userId: account.account.id,
    });
    await expect(
      reader.searchPlayers({
        query: account.account.username!,
        excludeUserId: randomUUID(),
        limit: 5,
      }),
    ).resolves.toHaveLength(1);
    await expect(reader.getAccounts([account.account.id])).resolves.toHaveProperty('size', 1);
  });

  it('fails the read when the binding throws and the caller asked for it', async () => {
    const account = await seedPlayerWithUser(db);
    const reader = new DrizzleAccountReader(db.drizzle, () => ({
      isRestricted: async () => {
        throw new Error('overlay down');
      },
    }));

    await expect(reader.getAccounts([account.account.id], ASK)).rejects.toThrow();
  });

  it('serves the stricter answer over the internal accounts route when asked', async () => {
    const refused = await seedPlayerWithUser(db);
    const router = createInternalAccountsRouter(
      new DrizzleAccountReader(db.drizzle, () => refusing(refused.account.id)),
      new Set(['chat']),
    );

    const asked = await call(
      router.accounts,
      { userIds: [refused.account.id], playEligibility: true },
      routeContext,
    );
    const notAsked = await call(router.accounts, { userIds: [refused.account.id] }, routeContext);

    expect(asked.accounts[0]?.excluded).toBe(true);
    expect(notAsked.accounts[0]?.excluded).toBe(false);
  });

  it('resolves the binding at call time, so a later rebinding applies', async () => {
    const account = await seedPlayerWithUser(db);
    let bound: PlayEligibilityPort = new PlayEligibilityService(db.drizzle);
    const reader = new DrizzleAccountReader(db.drizzle, () => bound);

    expect(
      (await reader.getAccounts([account.account.id], ASK)).get(account.account.id)?.excluded,
    ).toBe(false);
    bound = refusing(account.account.id);

    expect(
      (await reader.getAccounts([account.account.id], ASK)).get(account.account.id)?.excluded,
    ).toBe(true);
  });

  it("does not ask core's own port a second time", async () => {
    const account = await seedPlayerWithUser(db);
    const core = new PlayEligibilityService(db.drizzle);
    let asked = 0;
    core.checkPlay = async () => {
      asked += 1;
      return null;
    };
    const reader = new DrizzleAccountReader(db.drizzle, () => core);

    await reader.getAccounts([account.account.id], ASK);

    expect(asked).toBe(0);
  });
});
