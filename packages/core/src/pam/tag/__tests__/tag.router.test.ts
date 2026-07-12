import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../../testing/mock.js';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { createTagRouter } from '../router/index.js';
import type { TagService } from '../service/tag.service.js';
import type { TagRuleService } from '../service/tag-rule.service.js';

const CTX = { request: { headers: {} } };

function fakeDenyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async () => {
      throw new ORPCError('FORBIDDEN', { message: 'Missing permission: tag-rule' });
    }),
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
});
