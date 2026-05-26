import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { AdminGuard } from '@oss/auth';
import { mapErrors } from '@oss/core';
import { contract } from '@oss/orpc-contract';
import { CmsService, PageNotFoundError, BannerNotFoundError } from '../service/cms.service.js';

@Controller()
export class CmsController {
  constructor(
    private readonly cms: CmsService,
    private readonly adminGuard: AdminGuard,
  ) {}

  @Implement(contract.cms)
  cmsRoutes() {
    return {
      // Public reads.
      listPages: implement(contract.cms.listPages).handler(() => this.cms.listPages()),

      getPage: implement(contract.cms.getPage).handler(({ input }) =>
        mapErrors({ NOT_FOUND: PageNotFoundError }, () => this.cms.getPage(input.slug)),
      ),

      // Admin writes.
      createPage: implement(contract.cms.createPage).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return this.cms.createPage(input);
      }),

      updatePage: implement(contract.cms.updatePage).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return mapErrors({ NOT_FOUND: PageNotFoundError }, () => this.cms.updatePage(input));
      }),

      deletePage: implement(contract.cms.deletePage).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return mapErrors({ NOT_FOUND: PageNotFoundError }, () => this.cms.deletePage(input.id));
      }),

      // Public reads.
      listBanners: implement(contract.cms.listBanners).handler(() => this.cms.listBanners()),

      listBannersByPlacement: implement(contract.cms.listBannersByPlacement).handler(({ input }) =>
        this.cms.listBannersByPlacement(input.placement),
      ),

      // Admin writes.
      createBanner: implement(contract.cms.createBanner).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return this.cms.createBanner(input);
      }),

      updateBanner: implement(contract.cms.updateBanner).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return mapErrors({ NOT_FOUND: BannerNotFoundError }, () => this.cms.updateBanner(input));
      }),

      deleteBanner: implement(contract.cms.deleteBanner).handler(async ({ input, context }) => {
        await this.adminGuard.assert(context);
        return mapErrors({ NOT_FOUND: BannerNotFoundError }, () => this.cms.deleteBanner(input.id));
      }),
    };
  }
}
