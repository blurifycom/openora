import { implement } from '@orpc/server';
import { AdminGuard, mapErrors, type OssContext } from '@openora/core/server';
import { cmsContract } from '../contract/index.js';
import { CmsService, PageNotFoundError, BannerNotFoundError } from '../service/cms.service.js';

export function createCmsRouter(cms: CmsService, adminGuard: AdminGuard) {
  const os = implement(cmsContract).$context<OssContext>();

  return os.router({
    listPages: os.listPages.handler(() => cms.listPages()),

    getPage: os.getPage.handler(({ input }) =>
      mapErrors({ NOT_FOUND: PageNotFoundError }, () => cms.getPage(input.slug)),
    ),

    createPage: os.createPage.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'content', 'create');
      return cms.createPage(input, caller.userId);
    }),

    updatePage: os.updatePage.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'content', 'update');
      return mapErrors({ NOT_FOUND: PageNotFoundError }, () =>
        cms.updatePage(input, caller.userId),
      );
    }),

    deletePage: os.deletePage.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'content', 'delete');
      return mapErrors({ NOT_FOUND: PageNotFoundError }, () =>
        cms.deletePage(input.id, caller.userId),
      );
    }),

    listBanners: os.listBanners.handler(() => cms.listBanners()),

    listBannersByPlacement: os.listBannersByPlacement.handler(({ input }) =>
      cms.listBannersByPlacement(input.placement),
    ),

    createBanner: os.createBanner.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'content', 'create');
      return cms.createBanner(input, caller.userId);
    }),

    updateBanner: os.updateBanner.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'content', 'update');
      return mapErrors({ NOT_FOUND: BannerNotFoundError }, () =>
        cms.updateBanner(input, caller.userId),
      );
    }),

    deleteBanner: os.deleteBanner.handler(async ({ input, context }) => {
      const caller = await adminGuard.assert(context, 'content', 'delete');
      return mapErrors({ NOT_FOUND: BannerNotFoundError }, () =>
        cms.deleteBanner(input.id, caller.userId),
      );
    }),
  });
}
