import { describe, it, expect, vi } from 'vitest';
import { mock, mockDb } from '../../../testing/mock.js';
import type { EventBus } from '@openora/core/server';
import type { Tag, PlayerTag } from '../schema/index.js';
import {
  TagService,
  TagNotFoundError,
  TagAlreadyInUseError,
  TagAssignmentNotFoundError,
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
    it('inserts and returns the created tag with serialized dates', async () => {
      const tagRow = makeTag();
      const { drizzle } = makeDrizzle({ returning: [[tagRow]] });
      const svc = new TagService(drizzle, makeEvents());
      const result = await svc.createTag({ key: 'high_roller', isSticky: false });
      expect(result).toEqual({
        ...tagRow,
        createdAt: tagRow.createdAt.toISOString(),
        updatedAt: tagRow.updatedAt.toISOString(),
      });
    });
  });

  describe('deleteTag', () => {
    it('deletes and returns true', async () => {
      const { drizzle } = makeDrizzle({ select: [[]] });
      const svc = new TagService(drizzle, makeEvents());
      const result = await svc.deleteTag({ key: 'high_roller' });
      expect(result).toBe(true);
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
});
