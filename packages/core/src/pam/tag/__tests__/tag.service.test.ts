import { describe, it, expect, vi } from 'vitest';
import { DatabaseError } from 'pg';
import { mock, mockDb } from '../../../testing/mock.js';
import type { EventBus, DrizzleTx } from '@openora/core/server';
import { tag as tagTable, type Tag, type PlayerTag } from '../schema/index.js';
import {
  TagService,
  TagNotFoundError,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
  TagKeyConflictError,
  TagInUseError,
} from '../service/tag.service.js';

const PLAYER_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const TAG_ID = '33333333-3333-4333-8333-333333333333';
const PT_ID = '44444444-4444-4444-8444-444444444444';

type Row = Record<string, unknown>;

/**
 * Chainable, awaitable Drizzle query double. Chain methods return the same builder;
 * awaiting it (via `then`) pops the next entry from `results.select`; calling
 * `.returning()` pops from `results.returning`. Supply results in call order.
 */
function makeQueryBuilder(results: { select: Row[][]; returning: Row[][] }) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder['select'] = vi.fn(chain);
  builder['from'] = vi.fn(chain);
  builder['innerJoin'] = vi.fn(chain);
  builder['where'] = vi.fn(chain);
  builder['limit'] = vi.fn(chain);
  builder['offset'] = vi.fn(chain);
  builder['insert'] = vi.fn(chain);
  builder['values'] = vi.fn(chain);
  builder['onConflictDoNothing'] = vi.fn(chain);
  builder['update'] = vi.fn(chain);
  builder['set'] = vi.fn(chain);
  builder['delete'] = vi.fn(chain);
  builder['orderBy'] = vi.fn(chain);
  builder['returning'] = vi.fn(() => Promise.resolve(results.returning.shift() ?? []));
  // oxlint-disable-next-line unicorn/no-thenable -- builder must be awaitable to mimic Drizzle
  builder['then'] = (resolve: (v: Row[]) => unknown) => resolve(results.select.shift() ?? []);
  return builder;
}

function makeDrizzle(results: { select?: Row[][]; returning?: Row[][] } = {}) {
  const state = { select: results.select ?? [], returning: results.returning ?? [] };
  const builder = makeQueryBuilder(state);
  const db = {
    ...builder,
    transaction: vi.fn(async (fn: (txn: unknown) => Promise<unknown>) => fn(builder)),
  };
  return { drizzle: mockDb(db), db };
}

function makePgDatabaseError(code: string): DatabaseError {
  const err = new DatabaseError('simulated pg constraint violation', 0, 'error');
  err.code = code;
  return err;
}

/**
 * Models a query builder whose insert/delete statement itself rejects (a real
 * Postgres constraint violation), not a pre-check SELECT - createTag/deleteTag have
 * no pre-check, so this is the only way their DatabaseError-detection branch fires.
 */
function makeThrowingDrizzle(err: unknown) {
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder['insert'] = vi.fn(chain);
  builder['values'] = vi.fn(chain);
  builder['delete'] = vi.fn(chain);
  builder['where'] = vi.fn(chain);
  builder['returning'] = vi.fn(() => Promise.reject(err));
  // oxlint-disable-next-line unicorn/no-thenable -- builder must be awaitable to mimic Drizzle.
  // Both createTag and deleteTag call .returning(), which rejects above; `then` is kept as a
  // defensive fallback in case a caller ever awaits the builder directly instead.
  builder['then'] = (_resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    reject?.(err);
  return mockDb(builder);
}

/**
 * Models the partial unique index (player_tag_active_key) that backs
 * onConflictDoNothing under real concurrency: every caller's pre-check SELECT sees
 * "no existing row" (the race window every caller opened before any commit), but
 * only the first caller to reach the insert's `.returning()` claims the row - every
 * later one gets an empty result, exactly like the DB would reject the duplicate.
 */
function makeConcurrentAssignDrizzle(tagRow: Tag, ptRowFactory: () => PlayerTag) {
  let claimed = false;
  let currentFrom: unknown = null;
  const builder: Record<string, unknown> = {};
  const chain = () => builder;
  builder['select'] = vi.fn(chain);
  builder['from'] = vi.fn((table: unknown) => {
    currentFrom = table;
    return builder;
  });
  builder['where'] = vi.fn(chain);
  builder['limit'] = vi.fn(chain);
  builder['insert'] = vi.fn(chain);
  builder['values'] = vi.fn(chain);
  builder['onConflictDoNothing'] = vi.fn(chain);
  builder['returning'] = vi.fn(() => {
    if (claimed) {
      return Promise.resolve([]);
    }
    claimed = true;
    return Promise.resolve([ptRowFactory()]);
  });
  // oxlint-disable-next-line unicorn/no-thenable -- builder must be awaitable to mimic Drizzle
  builder['then'] = (resolve: (v: Row[]) => unknown) =>
    resolve(currentFrom === tagTable ? [tagRow] : []);
  const db = {
    ...builder,
    transaction: vi.fn(async (fn: (txn: unknown) => Promise<unknown>) => fn(builder)),
  };
  return mockDb(db);
}

function makeEvents() {
  return mock<EventBus>({ emit: vi.fn(), on: vi.fn() });
}

function makeTag(overrides: Partial<Tag> = {}): Tag {
  return {
    id: TAG_ID,
    key: 'high_roller',
    isSticky: false,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

function makePlayerTag(overrides: Partial<PlayerTag> = {}): PlayerTag {
  return {
    id: PT_ID,
    playerId: PLAYER_ID,
    tagId: TAG_ID,
    assignReason: 'test assign reason',
    assignActor: 'manual',
    assignActorUserId: ACTOR_ID,
    assignMetadata: null,
    removedAt: null,
    removalReason: null,
    removalActor: null,
    removalActorUserId: null,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    ...overrides,
  };
}

describe('TagService', () => {
  describe('createTag', () => {
    it('inserts, returns the created tag with serialized dates, and emits tag.created', async () => {
      const tagRow = makeTag();
      const events = makeEvents();
      const { drizzle } = makeDrizzle({ returning: [[tagRow]] });
      const svc = new TagService(drizzle, events);
      const result = await svc.createTag({ key: 'high_roller', isSticky: false }, ACTOR_ID);
      expect(result).toEqual({
        ...tagRow,
        createdAt: tagRow.createdAt.toISOString(),
        updatedAt: tagRow.updatedAt.toISOString(),
      });
      expect(events.emit).toHaveBeenCalledWith('tag.created', {
        key: 'high_roller',
        isSticky: false,
        actorId: ACTOR_ID,
      });
    });

    it('throws TagKeyConflictError on a duplicate tag key (23505) and does not emit', async () => {
      const events = makeEvents();
      const drizzle = makeThrowingDrizzle(makePgDatabaseError('23505'));
      const svc = new TagService(drizzle, events);
      await expect(
        svc.createTag({ key: 'high_roller', isSticky: false }, ACTOR_ID),
      ).rejects.toBeInstanceOf(TagKeyConflictError);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('deleteTag', () => {
    it('deletes, returns true, and emits tag.deleted', async () => {
      const events = makeEvents();
      const tagRow = makeTag();
      const { drizzle } = makeDrizzle({ returning: [[tagRow]] });
      const svc = new TagService(drizzle, events);
      const result = await svc.deleteTag({ key: 'high_roller' }, ACTOR_ID);
      expect(result).toBe(true);
      expect(events.emit).toHaveBeenCalledWith('tag.deleted', {
        key: 'high_roller',
        actorId: ACTOR_ID,
      });
    });

    it('throws TagNotFoundError when the key does not exist (no row deleted) and does not emit', async () => {
      const events = makeEvents();
      const { drizzle } = makeDrizzle({ returning: [[]] });
      const svc = new TagService(drizzle, events);
      await expect(svc.deleteTag({ key: 'high_roller' }, ACTOR_ID)).rejects.toBeInstanceOf(
        TagNotFoundError,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('throws TagInUseError when a playerTag/tagRule row still references the key (23503) and does not emit', async () => {
      const events = makeEvents();
      const drizzle = makeThrowingDrizzle(makePgDatabaseError('23503'));
      const svc = new TagService(drizzle, events);
      await expect(svc.deleteTag({ key: 'high_roller' }, ACTOR_ID)).rejects.toBeInstanceOf(
        TagInUseError,
      );
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('listPlayerTags', () => {
    it('returns paginated items with total', async () => {
      const pt = makePlayerTag();
      const { drizzle } = makeDrizzle({
        select: [[{ pt, tagKey: 'high_roller' }], [{ n: 1 }]],
      });
      const svc = new TagService(drizzle, makeEvents());
      const result = await svc.listPlayerTags({ playerId: PLAYER_ID, page: 1, limit: 10 });
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({ playerId: PLAYER_ID, tag: { key: 'high_roller' } });
      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(10);
    });

    it('returns an empty page when the player has no active tags', async () => {
      const { drizzle } = makeDrizzle({ select: [[], [{ n: 0 }]] });
      const svc = new TagService(drizzle, makeEvents());
      const result = await svc.listPlayerTags({ playerId: PLAYER_ID, page: 1, limit: 10 });
      expect(result.items).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('listAssignableTags', () => {
    it('returns tags not already assigned to the player with serialized dates', async () => {
      const tagRow = makeTag();
      const { drizzle } = makeDrizzle({ select: [[tagRow]] });
      const svc = new TagService(drizzle, makeEvents());
      const result = await svc.listAssignableTags(PLAYER_ID);
      expect(result).toEqual([
        {
          ...tagRow,
          createdAt: tagRow.createdAt.toISOString(),
          updatedAt: tagRow.updatedAt.toISOString(),
        },
      ]);
    });

    it('returns an empty array when all tags are already assigned', async () => {
      const { drizzle } = makeDrizzle({ select: [[]] });
      const svc = new TagService(drizzle, makeEvents());
      expect(await svc.listAssignableTags(PLAYER_ID)).toEqual([]);
    });
  });

  describe('assignPlayerTag', () => {
    it('creates the assignment, returns PlayerTagWithTag, and emits tag.player.assigned', async () => {
      const tagRow = makeTag();
      const ptRow = makePlayerTag();
      const events = makeEvents();
      const { drizzle } = makeDrizzle({
        select: [[tagRow], []],
        returning: [[ptRow]],
      });
      const svc = new TagService(drizzle, events);

      const result = await svc.assignPlayerTag({
        playerId: PLAYER_ID,
        tagKey: 'high_roller',
        assignReason: 'test reason',
        assignActor: 'manual',
        assignActorUserId: ACTOR_ID,
      });

      expect(result).toMatchObject({ playerId: PLAYER_ID, tag: { key: 'high_roller' } });
      expect(events.emit).toHaveBeenCalledWith(
        'tag.player.assigned',
        expect.objectContaining({ playerId: PLAYER_ID, tagKey: 'high_roller', actorId: ACTOR_ID }),
      );
    });

    it('throws TagNotFoundError when the tag key does not exist', async () => {
      const { drizzle } = makeDrizzle({ select: [[]] });
      const svc = new TagService(drizzle, makeEvents());
      await expect(
        svc.assignPlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'manual',
          assignActorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(TagNotFoundError);
    });

    it('throws TagAlreadyInUseError when the tag is already active for the player', async () => {
      const tagRow = makeTag();
      const existingPt = makePlayerTag();
      const { drizzle } = makeDrizzle({ select: [[tagRow], [existingPt]] });
      const svc = new TagService(drizzle, makeEvents());
      await expect(
        svc.assignPlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'manual',
          assignActorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);
    });

    it('does not emit when the assignment fails', async () => {
      const events = makeEvents();
      const { drizzle } = makeDrizzle({ select: [[]] });
      const svc = new TagService(drizzle, events);
      await svc
        .assignPlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'manual',
          assignActorUserId: ACTOR_ID,
        })
        .catch(() => undefined);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('throws TagAlreadyInUseError when the insert loses the race despite a clean pre-check', async () => {
      // Pre-check SELECT sees no existing row (the race window), but the DB-level
      // partial unique index rejects the insert via onConflictDoNothing - the empty
      // returning() is the only signal a real race leaves behind.
      const tagRow = makeTag();
      const events = makeEvents();
      const { drizzle } = makeDrizzle({ select: [[tagRow], []], returning: [[]] });
      const svc = new TagService(drizzle, events);
      await expect(
        svc.assignPlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'manual',
          assignActorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('commits the metadata merge UPDATE inside the same db.transaction call that resolves normally before TagAlreadyInUseError is thrown (regression: the merge must not be rolled back by the transaction it runs in)', async () => {
      // This is the ONE real production path (TagEvaluationService.tryAssignTag ->
      // assignPlayerTag, its own db.transaction) that ever supplies breach metadata for an
      // already-active tag. The bug: _assignPlayerTagOnTx used to throw TagAlreadyInUseError
      // from INSIDE the db.transaction callback for this case, so the merge UPDATE it had
      // just issued was rolled back along with the whole transaction before the error
      // reached this test. The fix returns a status instead, so db.transaction's own
      // promise resolves normally (proving nothing crossed the transaction boundary to
      // trigger a rollback) and the throw happens only afterwards, in assignPlayerTag itself.
      const tagRow = makeTag({ key: 'high_risk' });
      const existingCountBreach = { count: 5, thresholdCount: 3, thresholdDays: 30 };
      const incomingAmountBreach = { amount: '500.00', threshold: '400.00' };
      const existingPt = makePlayerTag({
        assignMetadata: { amountBreach: null, countBreach: existingCountBreach },
      });
      const events = makeEvents();
      // Own-db.transaction path (same shape as makeDrizzle), but with update/set/transaction
      // kept as directly-typed spies so we can assert on them without going through the
      // builder's untyped index signature.
      const builder = makeQueryBuilder({ select: [[tagRow], [existingPt]], returning: [] });
      const updateSpy = vi.fn(() => builder);
      const setSpy = vi.fn(() => builder);
      builder['update'] = updateSpy;
      builder['set'] = setSpy;
      const transactionSpy = vi.fn(async (fn: (txn: unknown) => Promise<unknown>) => fn(builder));
      const svc = new TagService(mockDb({ ...builder, transaction: transactionSpy }), events);

      await expect(
        svc.assignPlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_risk',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: ACTOR_ID,
          assignMetadata: { amountBreach: incomingAmountBreach, countBreach: null },
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);

      // The key regression check: db.transaction's own promise resolved (not rejected).
      // Under the old code, _assignPlayerTagOnTx threw inside the callback, so this same
      // db.transaction call would have REJECTED - and Postgres would roll back the UPDATE
      // along with it. TagAlreadyInUseError now surfaces only after this call settled.
      expect(transactionSpy).toHaveResolved();
      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledWith({
        assignMetadata: { amountBreach: incomingAmountBreach, countBreach: existingCountBreach },
      });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('creates exactly one active row when 5 concurrent calls race for the same player+tag', async () => {
      const tagRow = makeTag();
      const events = makeEvents();
      const drizzle = makeConcurrentAssignDrizzle(tagRow, () => makePlayerTag());
      const svc = new TagService(drizzle, events);
      const input = {
        playerId: PLAYER_ID,
        tagKey: 'high_roller' as const,
        assignReason: 'test reason',
        assignActor: 'manual' as const,
        assignActorUserId: ACTOR_ID,
      };

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
      expect(events.emit).toHaveBeenCalledTimes(1);
    });
  });

  describe('assignPlayerTagInTx', () => {
    it('assigns on the caller-supplied transaction handle (no own db.transaction), returns PlayerTagWithTag, and emits tag.player.assigned', async () => {
      const tagRow = makeTag();
      const ptRow = makePlayerTag();
      const events = makeEvents();
      // A bare builder standing in for a caller's transaction handle - assignPlayerTagInTx
      // must operate directly on it, never opening its own db.transaction.
      const trx = mock<DrizzleTx>(
        makeQueryBuilder({ select: [[tagRow], []], returning: [[ptRow]] }),
      );
      const db = { transaction: vi.fn() };
      const svc = new TagService(mockDb(db), events);

      const result = await svc.assignPlayerTagInTx(trx, {
        playerId: PLAYER_ID,
        tagKey: 'high_roller',
        assignReason: 'test reason',
        assignActor: 'scheduled',
        assignActorUserId: ACTOR_ID,
      });

      expect(db.transaction).not.toHaveBeenCalled();
      expect(result).toMatchObject({ playerId: PLAYER_ID, tag: { key: 'high_roller' } });
      expect(events.emit).toHaveBeenCalledWith(
        'tag.player.assigned',
        expect.objectContaining({ playerId: PLAYER_ID, tagKey: 'high_roller', actorId: ACTOR_ID }),
      );
    });

    it('throws TagAlreadyInUseError and does not emit when already active', async () => {
      const tagRow = makeTag();
      const existingPt = makePlayerTag();
      const events = makeEvents();
      const trx = mock<DrizzleTx>(
        makeQueryBuilder({ select: [[tagRow], [existingPt]], returning: [] }),
      );
      const svc = new TagService(mockDb({ transaction: vi.fn() }), events);

      await expect(
        svc.assignPlayerTagInTx(trx, {
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('merges a newly-observed breach dimension into an already-active tag before throwing', async () => {
      const tagRow = makeTag({ key: 'high_risk' });
      const existingCountBreach = { count: 5, thresholdCount: 3, thresholdDays: 30 };
      const incomingAmountBreach = { amount: '500.00', threshold: '400.00' };
      const existingPt = makePlayerTag({
        assignMetadata: { amountBreach: null, countBreach: existingCountBreach },
      });
      const events = makeEvents();
      const builder = makeQueryBuilder({ select: [[tagRow], [existingPt]], returning: [] });
      const updateSpy = vi.fn(() => builder);
      const setSpy = vi.fn(() => builder);
      builder['update'] = updateSpy;
      builder['set'] = setSpy;
      const svc = new TagService(mockDb({ transaction: vi.fn() }), events);

      await expect(
        svc.assignPlayerTagInTx(mock<DrizzleTx>(builder), {
          playerId: PLAYER_ID,
          tagKey: 'high_risk',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: ACTOR_ID,
          assignMetadata: { amountBreach: incomingAmountBreach, countBreach: null },
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledWith({
        assignMetadata: { amountBreach: incomingAmountBreach, countBreach: existingCountBreach },
      });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not update when the incoming metadata is already fully covered by existing', async () => {
      const tagRow = makeTag({ key: 'high_risk' });
      const existingAssignMetadata = {
        amountBreach: { amount: '500.00', threshold: '400.00' },
        countBreach: { count: 5, thresholdCount: 3, thresholdDays: 30 },
      };
      const existingPt = makePlayerTag({ assignMetadata: existingAssignMetadata });
      const events = makeEvents();
      const builder = makeQueryBuilder({ select: [[tagRow], [existingPt]], returning: [] });
      const updateSpy = vi.fn(() => builder);
      builder['update'] = updateSpy;
      const svc = new TagService(mockDb({ transaction: vi.fn() }), events);

      await expect(
        svc.assignPlayerTagInTx(mock<DrizzleTx>(builder), {
          playerId: PLAYER_ID,
          tagKey: 'high_risk',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: ACTOR_ID,
          assignMetadata: { amountBreach: null, countBreach: existingAssignMetadata.countBreach },
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);

      expect(updateSpy).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('sets metadata directly to incoming when the existing row has none', async () => {
      const tagRow = makeTag({ key: 'high_risk' });
      const incomingAssignMetadata = {
        amountBreach: null,
        countBreach: { count: 5, thresholdCount: 3, thresholdDays: 30 },
      };
      const existingPt = makePlayerTag({ assignMetadata: null });
      const events = makeEvents();
      const builder = makeQueryBuilder({ select: [[tagRow], [existingPt]], returning: [] });
      const updateSpy = vi.fn(() => builder);
      const setSpy = vi.fn(() => builder);
      builder['update'] = updateSpy;
      builder['set'] = setSpy;
      const svc = new TagService(mockDb({ transaction: vi.fn() }), events);

      await expect(
        svc.assignPlayerTagInTx(mock<DrizzleTx>(builder), {
          playerId: PLAYER_ID,
          tagKey: 'high_risk',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: ACTOR_ID,
          assignMetadata: incomingAssignMetadata,
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);

      expect(updateSpy).toHaveBeenCalledTimes(1);
      expect(setSpy).toHaveBeenCalledWith({
        assignMetadata: incomingAssignMetadata,
      });
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('does not update at all when the assign call carries no metadata (every non-high_risk tag)', async () => {
      const tagRow = makeTag();
      const existingPt = makePlayerTag({ assignMetadata: null });
      const events = makeEvents();
      const builder = makeQueryBuilder({ select: [[tagRow], [existingPt]], returning: [] });
      const updateSpy = vi.fn(() => builder);
      builder['update'] = updateSpy;
      const svc = new TagService(mockDb({ transaction: vi.fn() }), events);

      await expect(
        svc.assignPlayerTagInTx(mock<DrizzleTx>(builder), {
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          assignReason: 'test reason',
          assignActor: 'scheduled',
          assignActorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(TagAlreadyInUseError);

      expect(updateSpy).not.toHaveBeenCalled();
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('removePlayerTag', () => {
    it('soft-deletes the assignment, returns PlayerTagWithTag, and emits tag.player.removed', async () => {
      const tagRow = makeTag();
      const activePt = makePlayerTag();
      const removedPt = makePlayerTag({
        removedAt: new Date(),
        removalReason: 'test removal',
        removalActor: 'manual',
        removalActorUserId: ACTOR_ID,
      });
      const events = makeEvents();
      const { drizzle } = makeDrizzle({
        select: [[tagRow], [activePt]],
        returning: [[removedPt]],
      });
      const svc = new TagService(drizzle, events);

      const result = await svc.removePlayerTag({
        playerId: PLAYER_ID,
        tagKey: 'high_roller',
        removalReason: 'test removal',
        removalActor: 'manual',
        removalActorUserId: ACTOR_ID,
      });

      expect(result).toMatchObject({ playerId: PLAYER_ID, tag: { key: 'high_roller' } });
      expect(events.emit).toHaveBeenCalledWith(
        'tag.player.removed',
        expect.objectContaining({ playerId: PLAYER_ID, tagKey: 'high_roller', actorId: ACTOR_ID }),
      );
    });

    it('throws TagNotFoundError when the tag key does not exist', async () => {
      const { drizzle } = makeDrizzle({ select: [[]] });
      const svc = new TagService(drizzle, makeEvents());
      await expect(
        svc.removePlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          removalReason: 'test removal',
          removalActor: 'manual',
          removalActorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(TagNotFoundError);
    });

    it('throws TagAssignmentNotFoundError when there is no active assignment', async () => {
      const tagRow = makeTag();
      const { drizzle } = makeDrizzle({ select: [[tagRow], []] });
      const svc = new TagService(drizzle, makeEvents());
      await expect(
        svc.removePlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          removalReason: 'test removal',
          removalActor: 'manual',
          removalActorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(TagAssignmentNotFoundError);
    });

    it('does not emit when the removal fails', async () => {
      const events = makeEvents();
      const { drizzle } = makeDrizzle({ select: [[]] });
      const svc = new TagService(drizzle, events);
      await svc
        .removePlayerTag({
          playerId: PLAYER_ID,
          tagKey: 'high_roller',
          removalReason: 'test removal',
          removalActor: 'manual',
          removalActorUserId: ACTOR_ID,
        })
        .catch(() => undefined);
      expect(events.emit).not.toHaveBeenCalled();
    });
  });

  describe('replacePlayerTag', () => {
    const levelTag = () => makeTag({ key: 'level' });
    const replaceArgs = {
      playerId: PLAYER_ID,
      tagKey: 'level',
      removalReason: 'player level changed',
      assignReason: 'player level set to 4',
      assignActor: 'scheduled',
      assignActorUserId: ACTOR_ID,
    } as const;

    it('removes the prior row and assigns the new one in ONE transaction, emitting both events', async () => {
      const priorPt = makePlayerTag({ assignReason: 'player level set to 3' });
      const removedPt = makePlayerTag({ removedAt: new Date() });
      const newPt = makePlayerTag({ assignReason: 'player level set to 4' });
      const events = makeEvents();
      // Query order inside the single tx: find tag (remove half), select active row,
      // update.returning; then find tag (assign half), pre-check select, insert.returning.
      const { drizzle, db } = makeDrizzle({
        select: [[levelTag()], [priorPt], [levelTag()], []],
        returning: [[removedPt], [newPt]],
      });
      const svc = new TagService(drizzle, events);

      const result = await svc.replacePlayerTag(replaceArgs);

      expect(result).toMatchObject({ playerId: PLAYER_ID, tag: { key: 'level' } });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith(
        'tag.player.removed',
        expect.objectContaining({
          playerId: PLAYER_ID,
          tagKey: 'level',
          reason: 'player level changed',
          actorId: ACTOR_ID,
        }),
      );
      expect(events.emit).toHaveBeenCalledWith(
        'tag.player.assigned',
        expect.objectContaining({
          playerId: PLAYER_ID,
          tagKey: 'level',
          reason: 'player level set to 4',
          actorId: ACTOR_ID,
        }),
      );
    });

    it('treats a missing active row as a no-op removal and only emits tag.player.assigned', async () => {
      const newPt = makePlayerTag({ assignReason: 'player level set to 4' });
      const events = makeEvents();
      const { drizzle, db } = makeDrizzle({
        select: [[levelTag()], [], [levelTag()], []],
        returning: [[newPt]],
      });
      const svc = new TagService(drizzle, events);

      const result = await svc.replacePlayerTag(replaceArgs);

      expect(result).toMatchObject({ playerId: PLAYER_ID });
      expect(db.transaction).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledTimes(1);
      expect(events.emit).toHaveBeenCalledWith('tag.player.assigned', expect.anything());
    });

    it('throws TagAlreadyInUseError and emits nothing when the assign half loses a concurrent race', async () => {
      const priorPt = makePlayerTag();
      const removedPt = makePlayerTag({ removedAt: new Date() });
      const events = makeEvents();
      // Assign half's pre-check finds an active row a concurrent replace committed
      // between our removal and insert - the whole swap rejects, nothing emits.
      const { drizzle } = makeDrizzle({
        select: [[levelTag()], [priorPt], [levelTag()], [makePlayerTag()]],
        returning: [[removedPt]],
      });
      const svc = new TagService(drizzle, events);

      await expect(svc.replacePlayerTag(replaceArgs)).rejects.toBeInstanceOf(TagAlreadyInUseError);
      expect(events.emit).not.toHaveBeenCalled();
    });

    it('throws TagNotFoundError when the tag key does not exist', async () => {
      const { drizzle } = makeDrizzle({ select: [[]] });
      const svc = new TagService(drizzle, makeEvents());
      await expect(svc.replacePlayerTag(replaceArgs)).rejects.toBeInstanceOf(TagNotFoundError);
    });
  });
});
