import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../../testing/mock.js';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { createTagRouter } from '../router/index.js';
import {
  TagAlreadyInUseError,
  TagKeyConflictError,
  TagInUseError,
  TagNotFoundError,
  type TagService,
} from '../service/tag.service.js';
import type { TagRuleService } from '../service/tag-rule.service.js';

const UID = '11111111-1111-4111-8111-111111111111';

const CTX = { request: { headers: {} } };
// assignPlayerTag/removePlayerTag also call getUserId(context) directly (independent
// of adminGuard.assert's return value), which requires a resolvable auth.userId.
const AUTHED_CTX = { request: { headers: {} }, auth: { userId: UID } };

function fakeDenyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async () => {
      throw new ORPCError('FORBIDDEN', { message: 'Missing permission' });
    }),
  });
}

function fakeAllowingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async () => ({ userId: UID, role: 'admin' })),
  });
}

function fakeTagService(): TagService {
  return mock<TagService>({});
}

function fakeRuleService(): TagRuleService {
  return mock<TagRuleService>({
    listTagRules: vi.fn(),
    upsertTagRule: vi.fn(),
  });
}

describe('tag router authz', () => {
  it('rejects listTagRules for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(call(router.listTagRules, {}, { context: CTX })).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects upsertTagRule for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(
      call(
        router.upsertTagRule,
        {
          tagKey: 'high_roller',
          isEnabled: true,
          threshold: '1000',
          thresholdDays: null,
          thresholdCount: null,
        },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects listPlayerTags for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(
      call(router.listPlayerTags, { playerId: UID, page: 1, limit: 20 }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects listAssignableTags for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(
      call(router.listAssignableTags, { playerId: UID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects createTag for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(
      call(router.createTag, { key: 'high_roller', isSticky: false }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects assignPlayerTag for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(
      call(
        router.assignPlayerTag,
        {
          playerId: UID,
          tagKey: 'high_roller',
          assignReason: 'manual review',
          assignActor: 'manual',
        },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects deleteTag for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(
      call(router.deleteTag, { key: 'high_roller' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects removePlayerTag for a non-privileged caller', async () => {
    const router = createTagRouter(fakeTagService(), fakeRuleService(), fakeDenyingGuard());
    await expect(
      call(
        router.removePlayerTag,
        {
          playerId: UID,
          tagKey: 'high_roller',
          removalReason: 'manual review',
          removalActor: 'manual',
        },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});

describe('tag router error mapping', () => {
  it('maps TagAlreadyInUseError to a CONFLICT response instead of a raw 500', async () => {
    const tagSvc = mock<TagService>({
      assignPlayerTag: vi.fn().mockRejectedValue(new TagAlreadyInUseError()),
    });
    const router = createTagRouter(tagSvc, fakeRuleService(), fakeAllowingGuard());
    await expect(
      call(
        router.assignPlayerTag,
        {
          playerId: UID,
          tagKey: 'high_roller',
          assignReason: 'manual review',
          assignActor: 'manual',
        },
        { context: AUTHED_CTX },
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps TagKeyConflictError (duplicate tag key) to a CONFLICT response', async () => {
    const tagSvc = mock<TagService>({
      createTag: vi.fn().mockRejectedValue(new TagKeyConflictError()),
    });
    const router = createTagRouter(tagSvc, fakeRuleService(), fakeAllowingGuard());
    await expect(
      call(router.createTag, { key: 'high_roller', isSticky: false }, { context: AUTHED_CTX }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps TagInUseError (FK-restrict on delete) to a CONFLICT response', async () => {
    const tagSvc = mock<TagService>({
      deleteTag: vi.fn().mockRejectedValue(new TagInUseError()),
    });
    const router = createTagRouter(tagSvc, fakeRuleService(), fakeAllowingGuard());
    await expect(
      call(router.deleteTag, { key: 'high_roller' }, { context: AUTHED_CTX }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('maps TagNotFoundError (deleting a nonexistent key) to a NOT_FOUND response', async () => {
    const tagSvc = mock<TagService>({
      deleteTag: vi.fn().mockRejectedValue(new TagNotFoundError('high_roller')),
    });
    const router = createTagRouter(tagSvc, fakeRuleService(), fakeAllowingGuard());
    await expect(
      call(router.deleteTag, { key: 'high_roller' }, { context: AUTHED_CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
