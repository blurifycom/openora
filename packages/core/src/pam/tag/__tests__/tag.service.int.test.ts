import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { TagKey } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { makeEventBus } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { playerTag, tag } from '../schema/index.js';
import {
  TagService,
  TagNotFoundError,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
  TagKeyConflictError,
  TagInUseError,
} from '../service/tag.service.js';

let db: TestDb;

function makeService() {
  const events = makeEventBus();
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

async function activeAssignmentRow(playerId: string, tagId: string) {
  const [row] = await db.drizzle.db
    .select()
    .from(playerTag)
    .where(
      and(
        eq(playerTag.playerId, playerId),
        eq(playerTag.tagId, tagId),
        isNull(playerTag.removedAt),
      ),
    );
  return row;
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
  it('persists the tag, returns it with serialized dates, and emits tag.created', async () => {
    const { svc, events } = makeService();
    const actorId = randomUUID();

    const created = await svc.createTag({ key: 'high_roller', isSticky: false }, actorId);

    expect(created).toMatchObject({ key: 'high_roller', isSticky: false });
    expect(typeof created?.createdAt).toBe('string');
    expect(await db.drizzle.db.select().from(tag)).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith('tag.created', {
      key: 'high_roller',
      isSticky: false,
      actorId,
    });
  });

  it('rejects a duplicate tag key on the unique constraint and does not emit twice', async () => {
    const { svc, events } = makeService();
    const actorId = randomUUID();
    await svc.createTag({ key: 'vip', isSticky: false }, actorId);

    await expect(svc.createTag({ key: 'vip', isSticky: false }, actorId)).rejects.toBeInstanceOf(
      TagKeyConflictError,
    );
    expect(await db.drizzle.db.select().from(tag)).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('TagService.deleteTag (real PG)', () => {
  it('removes an unused tag and emits tag.deleted', async () => {
    const { svc, events } = makeService();
    const actorId = randomUUID();
    await seedTag('vip');

    expect(await svc.deleteTag({ key: 'vip' }, actorId)).toBe(true);
    expect(await db.drizzle.db.select().from(tag)).toHaveLength(0);
    expect(events.emit).toHaveBeenCalledWith('tag.deleted', { key: 'vip', actorId });
  });

  it('throws TagNotFoundError when the key does not exist and does not emit', async () => {
    const { svc, events } = makeService();

    await expect(svc.deleteTag({ key: 'vip' }, randomUUID())).rejects.toBeInstanceOf(
      TagNotFoundError,
    );
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('refuses to delete a tag that is still assigned and does not emit', async () => {
    const { svc, events } = makeService();
    const t = await seedTag('vip');
    const p = await seedPlayer();
    await svc.assignPlayerTag(assignment(p.id, 'vip', randomUUID()));

    await expect(svc.deleteTag({ key: 'vip' }, randomUUID())).rejects.toBeInstanceOf(TagInUseError);
    expect(await db.drizzle.db.select().from(tag).where(eq(tag.id, t.id))).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
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

  it('merges a newly observed breach dimension into an already-active row, and the merge survives the TagAlreadyInUseError it throws afterward', async () => {
    const { svc, events } = makeService();
    await seedTag('high_risk');
    const p = await seedPlayer();
    const actorId = randomUUID();
    const existingCountBreach = { count: 5, thresholdCount: 3, thresholdDays: 30 };
    await svc.assignPlayerTag({
      playerId: p.id,
      tagKey: 'high_risk',
      assignReason: 'count breach',
      assignActor: 'scheduled',
      assignActorUserId: actorId,
      assignMetadata: { amountBreach: null, countBreach: existingCountBreach },
    });
    events.emit.mockClear();
    const incomingAmountBreach = { amount: '500.00', threshold: '400.00' };

    await expect(
      svc.assignPlayerTag({
        playerId: p.id,
        tagKey: 'high_risk',
        assignReason: 'amount breach',
        assignActor: 'scheduled',
        assignActorUserId: actorId,
        assignMetadata: { amountBreach: incomingAmountBreach, countBreach: null },
      }),
    ).rejects.toBeInstanceOf(TagAlreadyInUseError);

    expect(events.emit).not.toHaveBeenCalled();
    const [row] = await playerTagsOf(p.id);
    expect(row?.assignMetadata).toEqual({
      amountBreach: incomingAmountBreach,
      countBreach: existingCountBreach,
    });
  });

  it('creates exactly one active row when 5 concurrent calls race for the same player+tag', async () => {
    const { svc, events } = makeService();
    await seedTag('high_roller');
    const p = await seedPlayer();
    const input = assignment(p.id, 'high_roller', randomUUID());

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => svc.assignPlayerTag(input)),
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(4);
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(TagAlreadyInUseError);
    }
    expect(await playerTagsOf(p.id)).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledTimes(1);
  });
});

describe('TagService.assignPlayerTagInTx (real PG)', () => {
  it('writes on the caller-supplied transaction only - rolling back the outer transaction rolls back the assignment too', async () => {
    const { svc } = makeService();
    await seedTag('high_roller');
    const p = await seedPlayer();
    const actorId = randomUUID();
    const rollbackError = new Error('deliberate rollback');

    await expect(
      db.drizzle.db.transaction(async (trx) => {
        await svc.assignPlayerTagInTx(trx, {
          playerId: p.id,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: actorId,
        });
        throw rollbackError;
      }),
    ).rejects.toThrow(rollbackError);

    expect(await playerTagsOf(p.id)).toHaveLength(0);
  });

  it('assigns, returns PlayerTagWithTag, and emits tag.player.assigned once the outer transaction commits', async () => {
    const { svc, events } = makeService();
    await seedTag('high_roller');
    const p = await seedPlayer();
    const actorId = randomUUID();

    const result = await db.drizzle.db.transaction((trx) =>
      svc.assignPlayerTagInTx(trx, {
        playerId: p.id,
        tagKey: 'high_roller',
        assignReason: 'test reason',
        assignActor: 'scheduled',
        assignActorUserId: actorId,
      }),
    );

    expect(result).toMatchObject({ playerId: p.id, tag: { key: 'high_roller' } });
    expect(await playerTagsOf(p.id)).toHaveLength(1);
    expect(events.emit).toHaveBeenCalledWith(
      'tag.player.assigned',
      expect.objectContaining({ playerId: p.id, tagKey: 'high_roller', actorId }),
    );
  });

  it('throws TagAlreadyInUseError and does not emit when already active', async () => {
    const { svc, events } = makeService();
    await seedTag('high_roller');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag(assignment(p.id, 'high_roller', actorId));
    events.emit.mockClear();

    await expect(
      db.drizzle.db.transaction((trx) =>
        svc.assignPlayerTagInTx(trx, {
          playerId: p.id,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: actorId,
        }),
      ),
    ).rejects.toBeInstanceOf(TagAlreadyInUseError);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('merges a newly-observed breach dimension into an already-active row before throwing', async () => {
    const { svc, events } = makeService();
    await seedTag('high_risk');
    const p = await seedPlayer();
    const actorId = randomUUID();
    const existingCountBreach = { count: 5, thresholdCount: 3, thresholdDays: 30 };
    await svc.assignPlayerTag({
      playerId: p.id,
      tagKey: 'high_risk',
      assignReason: 'count breach',
      assignActor: 'scheduled',
      assignActorUserId: actorId,
      assignMetadata: { amountBreach: null, countBreach: existingCountBreach },
    });
    events.emit.mockClear();
    const incomingAmountBreach = { amount: '500.00', threshold: '400.00' };

    await db.drizzle.db.transaction((trx) =>
      expect(
        svc.assignPlayerTagInTx(trx, {
          playerId: p.id,
          tagKey: 'high_risk',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: actorId,
          assignMetadata: { amountBreach: incomingAmountBreach, countBreach: null },
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError),
    );

    const [row] = await playerTagsOf(p.id);
    expect(row?.assignMetadata).toEqual({
      amountBreach: incomingAmountBreach,
      countBreach: existingCountBreach,
    });
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not update when the incoming metadata is already fully covered by existing', async () => {
    const { svc, events } = makeService();
    await seedTag('high_risk');
    const p = await seedPlayer();
    const actorId = randomUUID();
    const existingAssignMetadata = {
      amountBreach: { amount: '500.00', threshold: '400.00' },
      countBreach: { count: 5, thresholdCount: 3, thresholdDays: 30 },
    };
    await svc.assignPlayerTag({
      playerId: p.id,
      tagKey: 'high_risk',
      assignReason: 'both breaches',
      assignActor: 'scheduled',
      assignActorUserId: actorId,
      assignMetadata: existingAssignMetadata,
    });
    const [before] = await playerTagsOf(p.id);
    events.emit.mockClear();

    await db.drizzle.db.transaction((trx) =>
      expect(
        svc.assignPlayerTagInTx(trx, {
          playerId: p.id,
          tagKey: 'high_risk',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: actorId,
          assignMetadata: { amountBreach: null, countBreach: existingAssignMetadata.countBreach },
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError),
    );

    const [after] = await playerTagsOf(p.id);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(after?.assignMetadata).toEqual(existingAssignMetadata);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('sets metadata directly to incoming when the existing row has none', async () => {
    const { svc, events } = makeService();
    await seedTag('high_risk');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag({
      playerId: p.id,
      tagKey: 'high_risk',
      assignReason: 'no metadata yet',
      assignActor: 'scheduled',
      assignActorUserId: actorId,
    });
    events.emit.mockClear();
    const incomingAssignMetadata = {
      amountBreach: null,
      countBreach: { count: 5, thresholdCount: 3, thresholdDays: 30 },
    };

    await db.drizzle.db.transaction((trx) =>
      expect(
        svc.assignPlayerTagInTx(trx, {
          playerId: p.id,
          tagKey: 'high_risk',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: actorId,
          assignMetadata: incomingAssignMetadata,
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError),
    );

    const [row] = await playerTagsOf(p.id);
    expect(row?.assignMetadata).toEqual(incomingAssignMetadata);
    expect(events.emit).not.toHaveBeenCalled();
  });

  it('does not update at all when the assign call carries no metadata (every non-high_risk tag)', async () => {
    const { svc, events } = makeService();
    await seedTag('high_roller');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag(assignment(p.id, 'high_roller', actorId));
    const [before] = await playerTagsOf(p.id);
    events.emit.mockClear();

    await db.drizzle.db.transaction((trx) =>
      expect(
        svc.assignPlayerTagInTx(trx, {
          playerId: p.id,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: actorId,
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError),
    );

    const [after] = await playerTagsOf(p.id);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
    expect(events.emit).not.toHaveBeenCalled();
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

describe('TagService.replacePlayerTag (real PG)', () => {
  it('removes the prior row and assigns the new one atomically, emitting both events', async () => {
    const { svc, events } = makeService();
    const levelTag = await seedTag('level');
    const p = await seedPlayer();
    const actorId = randomUUID();
    await svc.assignPlayerTag({
      playerId: p.id,
      tagKey: 'level',
      assignReason: 'player level set to 3',
      assignActor: 'scheduled',
      assignActorUserId: actorId,
    });
    events.emit.mockClear();

    const result = await svc.replacePlayerTag({
      playerId: p.id,
      tagKey: 'level',
      removalReason: 'player level changed',
      assignReason: 'player level set to 4',
      assignActor: 'scheduled',
      assignActorUserId: actorId,
    });

    expect(result).toMatchObject({ playerId: p.id, tag: { key: 'level' } });
    const active = await activeAssignmentRow(p.id, levelTag.id);
    expect(active).toMatchObject({ assignReason: 'player level set to 4' });
    expect(await playerTagsOf(p.id)).toHaveLength(2);
    expect(events.emit).toHaveBeenCalledWith(
      'tag.player.removed',
      expect.objectContaining({
        playerId: p.id,
        tagKey: 'level',
        reason: 'player level changed',
        actorId,
      }),
    );
    expect(events.emit).toHaveBeenCalledWith(
      'tag.player.assigned',
      expect.objectContaining({
        playerId: p.id,
        tagKey: 'level',
        reason: 'player level set to 4',
        actorId,
      }),
    );
  });

  it('treats a missing active row as a no-op removal and only emits tag.player.assigned', async () => {
    const { svc, events } = makeService();
    await seedTag('level');
    const p = await seedPlayer();
    const actorId = randomUUID();

    const result = await svc.replacePlayerTag({
      playerId: p.id,
      tagKey: 'level',
      removalReason: 'player level changed',
      assignReason: 'player level set to 4',
      assignActor: 'scheduled',
      assignActorUserId: actorId,
    });

    expect(result).toMatchObject({ playerId: p.id });
    expect(events.emit).toHaveBeenCalledTimes(1);
    expect(events.emit).toHaveBeenCalledWith('tag.player.assigned', expect.anything());
  });

  it('rejects the loser of a concurrent replace with TagAlreadyInUseError, leaving exactly one active row', async () => {
    const { svc } = makeService();
    await seedTag('level');
    const p = await seedPlayer();
    const actorId = randomUUID();
    const args = {
      playerId: p.id,
      tagKey: 'level' as TagKey,
      removalReason: 'player level changed',
      assignReason: 'player level set to 1',
      assignActor: 'scheduled' as const,
      assignActorUserId: actorId,
    };
    const otherArgs = { ...args, assignReason: 'player level set to 2' };

    // Both replaces must actually overlap at the DB for one of them to lose. The seeds
    // above leave a single warm connection in the pool, so without this the second call
    // pays a TCP connect + startup handshake and can begin only after the first has
    // already committed - a legitimate sequential replace, and both succeed.
    await Promise.all([playerTagsOf(p.id), playerTagsOf(p.id)]);

    const results = await Promise.allSettled([
      svc.replacePlayerTag(args),
      svc.replacePlayerTag(otherArgs),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TagAlreadyInUseError);
    expect(await playerTagsOf(p.id)).toHaveLength(1);
  });

  it('throws TagNotFoundError when the tag key does not exist', async () => {
    const { svc } = makeService();
    const actorId = randomUUID();

    await expect(
      svc.replacePlayerTag({
        playerId: randomUUID(),
        tagKey: 'level',
        removalReason: 'player level changed',
        assignReason: 'player level set to 4',
        assignActor: 'scheduled',
        assignActorUserId: actorId,
      }),
    ).rejects.toBeInstanceOf(TagNotFoundError);
  });
});
