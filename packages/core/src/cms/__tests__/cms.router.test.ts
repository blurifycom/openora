import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../testing/mock.js';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import { createCmsRouter } from '../router/index.js';
import type { CmsService } from '../service/cms.service.js';

const CTX = { request: { headers: {} } };
const PAGE_ID = '11111111-1111-4111-8111-111111111111';
const BANNER_ID = '22222222-2222-4222-8222-222222222222';

function fakeDenyingGuard(): AdminGuard {
  return mock<AdminGuard>({
    assert: vi.fn(async () => {
      throw new ORPCError('FORBIDDEN', { message: 'Missing permission: content' });
    }),
  });
}

function fakeService(): CmsService {
  return mock<CmsService>({
    createPage: vi.fn(),
    updatePage: vi.fn(),
    deletePage: vi.fn(),
    createBanner: vi.fn(),
    updateBanner: vi.fn(),
    deleteBanner: vi.fn(),
  });
}

describe('cms router authz', () => {
  it('rejects createPage for a non-privileged caller', async () => {
    const router = createCmsRouter(fakeService(), fakeDenyingGuard());
    await expect(
      call(router.createPage, { slug: 'about', title: 'About' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects updatePage for a non-privileged caller', async () => {
    const router = createCmsRouter(fakeService(), fakeDenyingGuard());
    await expect(
      call(router.updatePage, { id: PAGE_ID, title: 'About v2' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects deletePage for a non-privileged caller', async () => {
    const router = createCmsRouter(fakeService(), fakeDenyingGuard());
    await expect(call(router.deletePage, { id: PAGE_ID }, { context: CTX })).rejects.toBeInstanceOf(
      ORPCError,
    );
  });

  it('rejects createBanner for a non-privileged caller', async () => {
    const router = createCmsRouter(fakeService(), fakeDenyingGuard());
    await expect(
      call(
        router.createBanner,
        { placement: 'home', title: 'Promo', imageUrl: 'https://example.test/a.png' },
        { context: CTX },
      ),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects updateBanner for a non-privileged caller', async () => {
    const router = createCmsRouter(fakeService(), fakeDenyingGuard());
    await expect(
      call(router.updateBanner, { id: BANNER_ID, title: 'Promo v2' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });

  it('rejects deleteBanner for a non-privileged caller', async () => {
    const router = createCmsRouter(fakeService(), fakeDenyingGuard());
    await expect(
      call(router.deleteBanner, { id: BANNER_ID }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
  });
});
