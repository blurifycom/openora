import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { EventBus } from '@openora/core/server';
import type { TagKey } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { mock } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { playerTag, tag } from '../schema/index.js';
import {
  TagService,
  TagNotFoundError,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
} from '../service/tag.service.js';

let db: TestDb;

function makeService() {
  const events = mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
  return { svc: new TagService(db.drizzle, events), events };
}

async function seedTag(key: TagKey, isSticky = false) {
  const [row] = await db.drizzle.db.insert(tag).values({ key, isSticky }).returning();
  return row!;
}

async function seedPlayer(overrides: Partial<typeof player.$inferInsert> = {}) {
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: randomUUID(), displayName: 'Player', ...overrides })
    .returning();
  return row!;
}

const assignment = (playerId: string, tagKey: TagKey, actorId: string) => ({
  playerId,
  tagKey,
  assignReason: 'manual review',
  assignActor: 'manual' as const,
  assignActorUserId: actorId,
});

const removal = (playerId: string, tagKey: TagKey, actorId: string) => ({
  playerId,
  tagKey,
  removalReason: 'no longer applies',
  removalActor: 'manual' as const,
  removalActorUserId: actorId,
});

async function playerTagsOf(playerId: string) {
  return db.drizzle.db.select().from(playerTag).where(eq(playerTag.playerId, playerId));
}

beforeAll(async () => {
  db = await createTestDb([migrate, migrateProfile]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player} RESTART IDENTITY CASCADE`,
  );
});

describe('TagService.createTag (real PG)', () => {
  it('persists the tag and returns it with serialized dates', async () => {
    const { svc } = makeService();

    const created = await svc.createTag({ key: 'high_roller', isSticky: false });

    expect(created).toMatchObject({ key: 'high_roller', isSticky: false });
    expect(typeof created?.createdAt).toBe('string');
    expect(await db.drizzle.db.select().from(tag)).toHaveLength(1);
  });

  it('rejects a duplicate tag key on the unique constraint', async () => {
    const { svc } = makeService();
    await svc.createTag({ key: 'vip', isSticky: false });

    await expect(svc.createTag({ key: 'vip', isSticky: false })).rejects.toThrow();
    expect(await db.drizzle.db.select().from(tag)).toHaveLength(1);
  });
});

describe('TagService.deleteTag (real PG)', () => {
  it('removes an unused tag', async () => {
    const { svc } = makeService();
    await seedTag('vip');

    expect(await svc.deleteTag({ key: 'vip' })).toBe(true);
    expect(await db.drizzle.db.select().from(tag)).toHaveLength(0);
  });

  it('refuses to delete a tag that is still assigned', async () => {
    const { svc } = makeService();
    const t = await seedTag('vip');
    const p = await seedPlayer();
    await svc.assignPlayerTag(assignment(p.id, 'vip', randomUUID()));

    await expect(svc.deleteTag({ key: 'vip' })).rejects.toThrow();
    expect(await db.drizzle.db.select().from(tag).where(eq(tag.id, t.id))).toHaveLength(1);
  });
});

describe('TagService.assignPlayerTag (real PG)', () => {
  it('writes the assignment with its actor trail and emits assigned', async () => {
    const { svc, events } = makeService();
    await seedTag('high_roller');
    const p = await seedPlayer();
    const actorId = randomUUID();

    const result = await svc.assignPlayerTag(assignment(p.id, 'high_roller', actorId));

    expect(result).toMatchObject({ playerId: p.id, tag: { key: 'high_roller' } });
    const rows = await playerTagsOf(p.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      assignActor: 'manual',
      assignActorUserId: actorId,
      removedAt: null,
    });
    expect(events.emit).toHaveBeenCalledWith(
      'tag.player.assigned',
      expect.objectContaining({ playerId: p.id, tagKey: 'high_roller', actorId }),
    );
  });

  it('throws TagNotFoundError for an unknown tag key', async () => {
    const { svc, events } = makeService();
    const p = await seedPlayer();

    await expect(svc.assignPlayerTag(assignment(p.id, 'vip', randomUUID()))).rejects.toBeInstanceOf(
      TagNotFoundError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('throws TagAlreadyInUseError on a second active assignment of the same tag', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    const p = await seedPlayer();
    await svc.assignPlayerTag(assignment(p.id, 'vip', randomUUID()));

    await expect(svc.assignPlayerTag(assignment(p.id, 'vip', randomUUID()))).rejects.toBeInstanceOf(
      TagAlreadyInUseError,
    );
    expect(await playerTagsOf(p.id)).toHaveLength(1);
  });

  it('allows a re-assignment once the previous one was removed', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag(assignment(p.id, 'vip', actorId));
    await svc.removePlayerTag(removal(p.id, 'vip', actorId));

    await svc.assignPlayerTag(assignment(p.id, 'vip', actorId));

    const rows = await playerTagsOf(p.id);
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.removedAt === null)).toHaveLength(1);
  });

  it('keeps the same tag assignable to different players', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    const first = await seedPlayer();
    const second = await seedPlayer();
    const actorId = randomUUID();

    await svc.assignPlayerTag(assignment(first.id, 'vip', actorId));
    await svc.assignPlayerTag(assignment(second.id, 'vip', actorId));

    expect(await playerTagsOf(first.id)).toHaveLength(1);
    expect(await playerTagsOf(second.id)).toHaveLength(1);
  });
});

describe('TagService.removePlayerTag (real PG)', () => {
  it('soft-deletes the assignment with its removal trail and emits removed', async () => {
    const { svc, events } = makeService();
    await seedTag('vip');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag(assignment(p.id, 'vip', actorId));

    const result = await svc.removePlayerTag(removal(p.id, 'vip', actorId));

    expect(result).toMatchObject({ tag: { key: 'vip' } });
    const [row] = await playerTagsOf(p.id);
    expect(row).toMatchObject({
      removalReason: 'no longer applies',
      removalActor: 'manual',
      removalActorUserId: actorId,
    });
    expect(row?.removedAt).toBeInstanceOf(Date);
    expect(events.emit).toHaveBeenCalledWith(
      'tag.player.removed',
      expect.objectContaining({ playerId: p.id, tagKey: 'vip', actorId }),
    );
  });

  it('throws TagNotFoundError for an unknown tag key', async () => {
    const { svc } = makeService();
    const p = await seedPlayer();

    await expect(svc.removePlayerTag(removal(p.id, 'vip', randomUUID()))).rejects.toBeInstanceOf(
      TagNotFoundError,
    );
  });

  it('throws TagAssignmentNotFoundError when nothing is active', async () => {
    const { svc, events } = makeService();
    await seedTag('vip');
    const p = await seedPlayer();

    await expect(svc.removePlayerTag(removal(p.id, 'vip', randomUUID()))).rejects.toBeInstanceOf(
      TagAssignmentNotFoundError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses to remove twice', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag(assignment(p.id, 'vip', actorId));
    await svc.removePlayerTag(removal(p.id, 'vip', actorId));

    await expect(svc.removePlayerTag(removal(p.id, 'vip', actorId))).rejects.toBeInstanceOf(
      TagAssignmentNotFoundError,
    );
  });
});

describe('TagService.listPlayerTags (real PG)', () => {
  it('lists only the active assignments with a matching total', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    await seedTag('high_roller');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag(assignment(p.id, 'vip', actorId));
    await svc.assignPlayerTag(assignment(p.id, 'high_roller', actorId));
    await svc.removePlayerTag(removal(p.id, 'vip', actorId));

    const result = await svc.listPlayerTags({ playerId: p.id, page: 1, limit: 20 });

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ tag: { key: 'high_roller' } });
  });

  it('returns an empty page for a player with no tags', async () => {
    const { svc } = makeService();

    const result = await svc.listPlayerTags({ playerId: randomUUID(), page: 1, limit: 20 });

    expect(result).toMatchObject({ items: [], total: 0 });
  });

  it('pages while the total covers the whole active set', async () => {
    const { svc } = makeService();
    const actorId = randomUUID();
    const p = await seedPlayer();
    for (const key of ['vip', 'high_roller', 'inactive'] as const) {
      await seedTag(key);
      await svc.assignPlayerTag(assignment(p.id, key, actorId));
    }

    const result = await svc.listPlayerTags({ playerId: p.id, page: 2, limit: 2 });

    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(1);
  });
});

describe('TagService.listAssignableTags (real PG)', () => {
  it('excludes tags the player already carries', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    await seedTag('high_roller');
    const p = await seedPlayer();
    await svc.assignPlayerTag(assignment(p.id, 'vip', randomUUID()));

    const assignable = await svc.listAssignableTags(p.id);

    expect(assignable.map((t) => t.key)).toEqual(['high_roller']);
  });

  it('offers a tag again once its assignment was removed', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag(assignment(p.id, 'vip', actorId));
    await svc.removePlayerTag(removal(p.id, 'vip', actorId));

    const assignable = await svc.listAssignableTags(p.id);

    expect(assignable.map((t) => t.key)).toEqual(['vip']);
  });

  it('returns nothing when every tag is already assigned', async () => {
    const { svc } = makeService();
    await seedTag('vip');
    const p = await seedPlayer();
    await svc.assignPlayerTag(assignment(p.id, 'vip', randomUUID()));

    expect(await svc.listAssignableTags(p.id)).toEqual([]);
  });
});
