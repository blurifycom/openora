import { implement } from '@orpc/server';
import { AdminGuard } from '@oss/core/server';
import { mapErrors, type OssContext } from '@oss/core/server';
import { cmsContract } from '../contract/index.js';
import { CmsService, PageNotFoundError, BannerNotFoundError } from '../service/cms.service.js';

export function createCmsRouter(cms: CmsService, adminGuard: AdminGuard) {
  const os = implement(cmsContract).$context<OssContext>();

  return os.router({
    // Public reads.
    listPages: os.listPages.handler(() => cms.listPages()),

    getPage: os.getPage.handler(({ input }) =>
      mapErrors({ NOT_FOUND: PageNotFoundError }, () => cms.getPage(input.slug)),
    ),

    // Admin writes.
    createPage: os.createPage.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'content', 'create');
      return cms.createPage(input);
    }),

    updatePage: os.updatePage.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'content', 'update');
      return mapErrors({ NOT_FOUND: PageNotFoundError }, () => cms.updatePage(input));
    }),

    deletePage: os.deletePage.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'content', 'delete');
      return mapErrors({ NOT_FOUND: PageNotFoundError }, () => cms.deletePage(input.id));
    }),

    // Public reads.
    listBanners: os.listBanners.handler(() => cms.listBanners()),

    listBannersByPlacement: os.listBannersByPlacement.handler(({ input }) =>
      cms.listBannersByPlacement(input.placement),
    ),

    // Admin writes.
    createBanner: os.createBanner.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'content', 'create');
      return cms.createBanner(input);
    }),

    updateBanner: os.updateBanner.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'content', 'update');
      return mapErrors({ NOT_FOUND: BannerNotFoundError }, () => cms.updateBanner(input));
    }),

    deleteBanner: os.deleteBanner.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'content', 'delete');
      return mapErrors({ NOT_FOUND: BannerNotFoundError }, () => cms.deleteBanner(input.id));
    }),
  });
}
