import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { ORPCError } from '@orpc/server';
import { contract } from '@oss/orpc-contract';
import { CmsService, PageNotFoundError, BannerNotFoundError } from '../service/cms.service.js';

@Controller()
export class CmsController {
  constructor(private readonly cms: CmsService) {}

  @Implement(contract.cms)
  cmsRoutes() {
    return {
      listPages: implement(contract.cms.listPages).handler(() => this.cms.listPages()),

      getPage: implement(contract.cms.getPage).handler(async ({ input }) => {
        try {
          return await this.cms.getPage(input.slug);
        } catch (err) {
          if (err instanceof PageNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      createPage: implement(contract.cms.createPage).handler(({ input }) =>
        this.cms.createPage(input),
      ),

      updatePage: implement(contract.cms.updatePage).handler(async ({ input }) => {
        try {
          return await this.cms.updatePage(input);
        } catch (err) {
          if (err instanceof PageNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      deletePage: implement(contract.cms.deletePage).handler(async ({ input }) => {
        try {
          return await this.cms.deletePage(input.id);
        } catch (err) {
          if (err instanceof PageNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      listBanners: implement(contract.cms.listBanners).handler(() => this.cms.listBanners()),

      listBannersByPlacement: implement(contract.cms.listBannersByPlacement).handler(({ input }) =>
        this.cms.listBannersByPlacement(input.placement),
      ),

      createBanner: implement(contract.cms.createBanner).handler(({ input }) =>
        this.cms.createBanner(input),
      ),

      updateBanner: implement(contract.cms.updateBanner).handler(async ({ input }) => {
        try {
          return await this.cms.updateBanner(input);
        } catch (err) {
          if (err instanceof BannerNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),

      deleteBanner: implement(contract.cms.deleteBanner).handler(async ({ input }) => {
        try {
          return await this.cms.deleteBanner(input.id);
        } catch (err) {
          if (err instanceof BannerNotFoundError) {
            throw new ORPCError('NOT_FOUND', { message: err.message });
          }
          throw err;
        }
      }),
    };
  }
}
