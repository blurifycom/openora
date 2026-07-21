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

type Router = ReturnType<typeof createCmsRouter>;

const GUARDED_ROUTES: ReadonlyArray<{ name: string; invoke: (r: Router) => Promise<unknown> }> = [
  {
    name: 'createPage',
    invoke: (r) => call(r.createPage, { slug: 'about', title: 'About' }, { context: CTX }),
  },
  {
    name: 'updatePage',
    invoke: (r) => call(r.updatePage, { id: PAGE_ID, title: 'About v2' }, { context: CTX }),
  },
  { name: 'deletePage', invoke: (r) => call(r.deletePage, { id: PAGE_ID }, { context: CTX }) },
  {
    name: 'createBanner',
    invoke: (r) =>
      call(
        r.createBanner,
        { placement: 'home', title: 'Promo', imageUrl: 'https://example.test/a.png' },
        { context: CTX },
      ),
  },
  {
    name: 'updateBanner',
    invoke: (r) => call(r.updateBanner, { id: BANNER_ID, title: 'Promo v2' }, { context: CTX }),
  },
  {
    name: 'deleteBanner',
    invoke: (r) => call(r.deleteBanner, { id: BANNER_ID }, { context: CTX }),
  },
];

describe('cms router authz', () => {
  it.each(GUARDED_ROUTES)('rejects $name for a non-privileged caller', async ({ invoke }) => {
    const router = createCmsRouter(fakeService(), fakeDenyingGuard());
    await expect(invoke(router)).rejects.toBeInstanceOf(ORPCError);
  });
});
