import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { createTestDb, seedPlayerWithUser, seedUser, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { migrate as migrateWallet } from '@openora/core/wallet/migrate';
import { ledgerPlayEligibilityProjection } from '@openora/core/wallet/seed';
import { migrate } from '../migrate.js';
import { user } from '../schema/index.js';
import { backfillPlayEligibility } from '../service/play-eligibility.service.js';

let db: TestDb;
let userIds: string[];

const ledger = () => ledgerPlayEligibilityProjection(db.drizzle.db);

async function oldStates(ids: readonly string[]) {
  const rows = await db.drizzle.db
    .select({
      userId: user.id,
      rgBlocked: user.rgBlocked,
      rgBlockedUntil: user.rgBlockedUntil,
      isActive: user.isActive,
      banned: user.banned,
      banExpires: user.banExpires,
      status: player.status,
    })
    .from(user)
    .leftJoin(player, eq(player.userId, user.id))
    .where(inArray(user.id, [...ids]));
  return new Map(
    rows.map(({ userId, banned, ...state }) => [userId, { ...state, banned: banned ?? false }]),
  );
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile, migrateWallet]);
  const until = new Date(Date.now() + 86_400_000);
  const seeded = await Promise.all([
    seedPlayerWithUser(db),
    seedPlayerWithUser(db, { status: 'closed' }),
    seedPlayerWithUser(db, { status: 'self_excluded' }),
    seedPlayerWithUser(db, { status: 'suspended' }),
  ]);
  const ids = seeded.map((s) => s.account.id);
  await db.drizzle.db
    .update(user)
    .set({ rgBlocked: true, rgBlockedUntil: until })
    .where(eq(user.id, ids[0] ?? ''));
  await db.drizzle.db
    .update(user)
    .set({ banned: true, isActive: false })
    .where(eq(user.id, ids[1] ?? ''));
  const noProfile = await seedUser(db);
  userIds = [...ids, noProfile.id];
  await backfillPlayEligibility(db.drizzle.db, ledger());
});

afterAll(async () => {
  await db.drop();
});

describe('LEDGER_PLAY_ELIGIBILITY answers what the identity and profile reads did', () => {
  it('stateOf, on the pool and on a caller transaction', async () => {
    const old = await oldStates(userIds);
    for (const userId of userIds) {
      const expected = old.get(userId);
      expect(await ledger().stateOf(userId)).toEqual(expected);
      const inTx = await db.drizzle.db.transaction((tx) => ledger().stateOf(userId, tx));
      expect(inTx).toEqual(expected);
    }
    expect(await ledger().stateOf(randomUUID())).toBeNull();
  });

  it('statesOf, on the pool and on a caller transaction', async () => {
    const asked = [...userIds, randomUUID()];
    const old = await oldStates(asked);
    const sorted = <T>(map: Map<string, T>) => [...map].sort(([a], [b]) => a.localeCompare(b));

    expect(sorted(await ledger().statesOf(asked))).toEqual(sorted(old));
    const inTx = await db.drizzle.db.transaction((tx) => ledger().statesOf(asked, tx));
    expect(sorted(inTx)).toEqual(sorted(old));
  });
});
