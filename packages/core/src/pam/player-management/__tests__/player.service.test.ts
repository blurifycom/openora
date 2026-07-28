import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { KycStatusWriter, TagKey } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { tag, playerTag } from '@openora/core/pam/schema/tag';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import { mock } from '../../../testing/mock.js';
import {
  PlayerService,
  PlayerNotFoundError,
  DuplicateEmailError,
} from '../service/player.service.js';

let db: TestDb;

function makeService(writer: Partial<KycStatusWriter> = { setStatus: vi.fn() }) {
  const kycStatusWriter = mock<KycStatusWriter>(writer);
  return { svc: new PlayerService(db.drizzle, kycStatusWriter), kycStatusWriter };
}

async function seedUser(overrides: Partial<typeof user.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(user)
    .values({ name: 'Player', email: `${randomUUID()}@example.com`, ...overrides })
    .returning();
  return row!;
}

async function seedPlayer(userId: string, overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId, displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

async function seedPlayerWithUser(
  userOverrides: Partial<typeof user.$inferInsert> = {},
  playerOverrides: Partial<typeof player.$inferInsert> = {},
) {
  const account = await seedUser(userOverrides);
  const row = await seedPlayer(account.id, playerOverrides);
  return { account, player: row };
}

async function seedTag(key: TagKey) {
  const [row] = await db.drizzle.db.insert(tag).values({ key }).returning();
  return row!;
}

async function assignTag(playerId: string, tagId: string) {
  await db.drizzle.db.insert(playerTag).values({
    playerId,
    tagId,
    assignReason: 'test',
    assignActor: 'manual',
    assignActorUserId: null,
  });
}

async function rowById(playerId: string) {
  const [row] = await db.drizzle.db.select().from(player).where(eq(player.id, playerId));
  return row;
}

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateTag]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player}, ${user} RESTART IDENTITY CASCADE`,
  );
});

describe('PlayerService.remove (real PG)', () => {
  it('soft-deletes by closing the player, never deletes the row', async () => {
    const { svc } = makeService();
    const { player: seeded } = await seedPlayerWithUser();

    const result = await svc.remove(seeded.id);

    expect(result).toEqual({ success: true });
    expect(await rowById(seeded.id)).toMatchObject({ status: 'closed' });
  });

  it('throws PlayerNotFoundError when the player does not exist', async () => {
    const { svc } = makeService();

    await expect(svc.remove(randomUUID())).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});

describe('PlayerService.getByUserId (real PG)', () => {
  it('returns the player enriched with the identity email', async () => {
    const { svc } = makeService();
    const { account, player: seeded } = await seedPlayerWithUser({ email: 'jordan@example.com' });

    const result = await svc.getByUserId(account.id);

    expect(result).toMatchObject({
      id: seeded.id,
      userId: account.id,
      email: 'jordan@example.com',
    });
  });

  it('throws PlayerNotFoundError when no player owns the userId', async () => {
    const { svc } = makeService();

    await expect(svc.getByUserId(randomUUID())).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});

describe('PlayerService.registrationsOverTime (real PG)', () => {
  it('returns one zero-filled bucket per day in the window', async () => {
    const { svc } = makeService();

    const points = await svc.registrationsOverTime(7);

    expect(points).toHaveLength(7);
    expect(points.every((p) => p.count === 0)).toBe(true);
    const dates = points.map((p) => p.date);
    expect(new Set(dates).size).toBe(7);
    expect(dates).toEqual([...dates].sort());
  });

  it('places each days registrations into its matching bucket', async () => {
    const { svc } = makeService();
    const todayKey = new Date().toISOString().slice(0, 10);
    await seedPlayer(randomUUID(), { createdAt: new Date() });
    await seedPlayer(randomUUID(), { createdAt: new Date() });
    await seedPlayer(randomUUID(), { createdAt: new Date() });

    const points = await svc.registrationsOverTime(7);

    const today = points.find((p) => p.date === todayKey);
    expect(today?.count).toBe(3);
    expect(points.filter((p) => p.date !== todayKey).every((p) => p.count === 0)).toBe(true);
  });
});

describe('PlayerService.list (real PG)', () => {
  it('filters by status', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'suspended' });

    const { items, total } = await svc.list({ page: 1, limit: 20, status: 'suspended' });

    expect(total).toBe(1);
    expect(items[0]?.status).toBe('suspended');
  });

  it('matches players by a display name substring', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({}, { displayName: 'Alice Anderson' });
    await seedPlayerWithUser({}, { displayName: 'Bob Baker' });

    const { items, total } = await svc.list({ page: 1, limit: 20, search: 'ander' });

    expect(total).toBe(1);
    expect(items[0]?.displayName).toBe('Alice Anderson');
  });

  it('matches players by an email substring', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({ email: 'searchable-target@example.com' });
    await seedPlayerWithUser({ email: 'someone-else@example.com' });

    const { items, total } = await svc.list({ page: 1, limit: 20, search: 'searchable-target' });

    expect(total).toBe(1);
    expect(items[0]?.email).toBe('searchable-target@example.com');
  });

  it('restricts results to players carrying any of the given tags, excluding removed assignments', async () => {
    const { svc } = makeService();
    const vip = await seedTag('vip');
    const highRisk = await seedTag('high_risk');
    const { player: tagged } = await seedPlayerWithUser();
    const { player: removedTag } = await seedPlayerWithUser();
    const { player: untagged } = await seedPlayerWithUser();
    await assignTag(tagged.id, vip.id);
    await assignTag(removedTag.id, highRisk.id);
    await db.drizzle.db
      .update(playerTag)
      .set({ removedAt: new Date() })
      .where(eq(playerTag.playerId, removedTag.id));

    const { items, total } = await svc.list({ page: 1, limit: 20, tags: ['vip', 'high_risk'] });

    expect(total).toBe(1);
    expect(items.map((i) => i.id)).toEqual([tagged.id]);
    expect(items.map((i) => i.id)).not.toContain(untagged.id);
  });

  it('keeps the total across the whole filtered set, not just the returned page', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'active' });
    await seedPlayerWithUser({}, { status: 'suspended' });

    const { items, total } = await svc.list({ page: 2, limit: 2, status: 'active' });

    expect(total).toBe(3);
    expect(items).toHaveLength(1);
  });

  it('orders by the requested sort field and direction', async () => {
    const { svc } = makeService();
    await seedPlayerWithUser({}, { displayName: 'Charlie' });
    await seedPlayerWithUser({}, { displayName: 'Alice' });
    await seedPlayerWithUser({}, { displayName: 'Bob' });

    const { items } = await svc.list({
      page: 1,
      limit: 20,
      sortBy: 'displayName',
      sortOrder: 'asc',
    });

    expect(items.map((i) => i.displayName)).toEqual(['Alice', 'Bob', 'Charlie']);
  });
});

describe('PlayerService.get / getExtended (real PG)', () => {
  it('returns the player with its assigned tags', async () => {
    const { svc } = makeService();
    const vip = await seedTag('vip');
    const { player: seeded } = await seedPlayerWithUser();
    await assignTag(seeded.id, vip.id);

    const result = await svc.get(seeded.id);

    expect(result.tags).toEqual(['vip']);
  });

  it('throws PlayerNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(svc.get(randomUUID())).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});

describe('PlayerService.update (real PG)', () => {
  it('persists simple field changes and returns the enriched row', async () => {
    const { svc } = makeService();
    const { player: seeded, account } = await seedPlayerWithUser();

    const result = await svc.update(seeded.id, { displayName: 'Renamed', level: 5 }, account.id);

    expect(result).toMatchObject({ displayName: 'Renamed', level: 5 });
    expect(await rowById(seeded.id)).toMatchObject({ displayName: 'Renamed', level: 5 });
  });

  it('throws DuplicateEmailError when the new email is already used by a different user', async () => {
    const { svc } = makeService();
    const taken = await seedUser({ email: 'taken@example.com' });
    const { player: seeded, account } = await seedPlayerWithUser();

    await expect(svc.update(seeded.id, { email: taken.email }, account.id)).rejects.toBeInstanceOf(
      DuplicateEmailError,
    );
  });

  it('delegates a kycStatus change to the KYC_STATUS_WRITER on the same transaction', async () => {
    const setStatus = vi.fn(async () => undefined);
    const { svc } = makeService({ setStatus });
    const { player: seeded, account } = await seedPlayerWithUser({}, { kycStatus: 'pending' });

    await svc.update(seeded.id, { kycStatus: 'verified' }, account.id);

    expect(setStatus).toHaveBeenCalledWith(
      account.id,
      'verified',
      { actorId: account.id, source: 'manual' },
      expect.anything(),
    );
  });

  it('does not call the KYC_STATUS_WRITER when kycStatus is unchanged', async () => {
    const setStatus = vi.fn(async () => undefined);
    const { svc } = makeService({ setStatus });
    const { player: seeded, account } = await seedPlayerWithUser({}, { kycStatus: 'verified' });

    await svc.update(seeded.id, { kycStatus: 'verified' }, account.id);

    expect(setStatus).not.toHaveBeenCalled();
  });

  it('rolls the whole update back when the KYC_STATUS_WRITER throws', async () => {
    const setStatus = vi.fn(async () => {
      throw new Error('writer down');
    });
    const { svc } = makeService({ setStatus });
    const { player: seeded, account } = await seedPlayerWithUser(
      {},
      { displayName: 'Original', kycStatus: 'pending' },
    );

    await expect(
      svc.update(seeded.id, { displayName: 'Renamed', kycStatus: 'verified' }, account.id),
    ).rejects.toThrow('writer down');

    expect(await rowById(seeded.id)).toMatchObject({
      displayName: 'Original',
      kycStatus: 'pending',
    });
  });

  it('throws PlayerNotFoundError for an unknown id', async () => {
    const { svc } = makeService();

    await expect(
      svc.update(randomUUID(), { displayName: 'X' }, randomUUID()),
    ).rejects.toBeInstanceOf(PlayerNotFoundError);
  });
});
