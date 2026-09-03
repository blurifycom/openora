import { implement } from '@orpc/server';
import { AdminGuard, mapErrors, type OssContext } from '@openora/core/server';
import { cmsContract } from '../contract/index.js';
import {
  CmsService,
  PageNotFoundError,
  BannerConfigurationNotFoundError,
  BannerConfigurationIsDefaultError,
  BannerConfigurationImageCountError,
  BannerImageNotFoundError,
  BannerImageHostNotAllowedError,
  BannerScheduleNotFoundError,
  BannerConfigurationHasScheduleError,
  BannerScheduleInvalidRangeError,
  BannerScheduleOverlapError,
} from '../service/cms.service.js';

export function createCmsRouter(cms: CmsService, adminGuard: AdminGuard) {
  const os = implement(cmsContract).$context<OssContext>();

  return os.router({
    listPages: os.listPages.handler(() => cms.listPages()),

    getPage: os.getPage.handler(({ input }) =>
      mapErrors({ NOT_FOUND: PageNotFoundError }, () => cms.getPage(input.slug)),
    ),

    createPage: os.createPage.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'create');
      return cms.createPage(input, userId, { ip, userAgent });
    }),

    updatePage: os.updatePage.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'update');
      return mapErrors({ NOT_FOUND: PageNotFoundError }, () =>
        cms.updatePage(input, userId, { ip, userAgent }),
      );
    }),

    deletePage: os.deletePage.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'delete');
      return mapErrors({ NOT_FOUND: PageNotFoundError }, () =>
        cms.deletePage(input.id, userId, { ip, userAgent }),
      );
    }),

    listBannerPlacements: os.listBannerPlacements.handler(async ({ context }) => {
      await adminGuard.assert(context, 'content', 'update');
      return cms.listPlacements();
    }),

    listBannerConfigurationsByPlacement: os.listBannerConfigurationsByPlacement.handler(
      async ({ input, context }) => {
        await adminGuard.assert(context, 'content', 'update');
        return cms.listConfigurationsByPlacement(input.placement);
      },
    ),

    unsetDefaultBannerConfiguration: os.unsetDefaultBannerConfiguration.handler(
      async ({ input, context }) => {
        const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'publish');
        return cms.unsetDefaultConfiguration(input.placement, userId, { ip, userAgent });
      },
    ),

    getBannerConfiguration: os.getBannerConfiguration.handler(async ({ input, context }) => {
      await adminGuard.assert(context, 'content', 'update');
      return mapErrors({ NOT_FOUND: BannerConfigurationNotFoundError }, () =>
        cms.getConfiguration(input.id),
      );
    }),

    createBannerConfiguration: os.createBannerConfiguration.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'create');
      return cms.createConfiguration(input, userId, { ip, userAgent });
    }),

    deleteBannerConfiguration: os.deleteBannerConfiguration.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'delete');
      await mapErrors(
        {
          NOT_FOUND: BannerConfigurationNotFoundError,
          CONFLICT: [BannerConfigurationIsDefaultError, BannerConfigurationHasScheduleError],
        },
        () => cms.deleteConfiguration(input.id, userId, { ip, userAgent }),
      );
      return { success: true as const };
    }),

    setDefaultBannerConfiguration: os.setDefaultBannerConfiguration.handler(
      async ({ input, context }) => {
        const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'publish');
        return mapErrors(
          {
            NOT_FOUND: BannerConfigurationNotFoundError,
            CONFLICT: [BannerConfigurationImageCountError, BannerConfigurationHasScheduleError],
          },
          () => cms.setDefaultConfiguration(input.id, userId, { ip, userAgent }),
        );
      },
    ),

    setBannerImage: os.setBannerImage.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'update');
      return mapErrors(
        {
          NOT_FOUND: BannerConfigurationNotFoundError,
          BAD_REQUEST: BannerImageHostNotAllowedError,
        },
        () => cms.setBannerImage(input, userId, { ip, userAgent }),
      );
    }),

    deleteBannerImage: os.deleteBannerImage.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'update');
      await mapErrors({ NOT_FOUND: BannerImageNotFoundError }, () =>
        cms.deleteBannerImage(input.id, userId, { ip, userAgent }),
      );
      return { success: true as const };
    }),

    getPublicBanner: os.getPublicBanner.handler(({ input }) =>
      cms.getPublicBanner(input.placement, input.locale),
    ),

    createBannerSchedule: os.createBannerSchedule.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'publish');
      return mapErrors(
        {
          NOT_FOUND: BannerConfigurationNotFoundError,
          CONFLICT: [
            BannerConfigurationIsDefaultError,
            BannerConfigurationHasScheduleError,
            BannerScheduleOverlapError,
            BannerConfigurationImageCountError,
          ],
          BAD_REQUEST: BannerScheduleInvalidRangeError,
        },
        () =>
          cms.createBannerSchedule(
            input.id,
            { startsAt: input.startsAt, endsAt: input.endsAt },
            userId,
            { ip, userAgent },
          ),
      );
    }),

    updateBannerScheduleEnd: os.updateBannerScheduleEnd.handler(async ({ input, context }) => {
      const { userId, ip, userAgent } = await adminGuard.assert(context, 'content', 'publish');
      return mapErrors(
        {
          NOT_FOUND: [BannerConfigurationNotFoundError, BannerScheduleNotFoundError],
          CONFLICT: BannerScheduleOverlapError,
          BAD_REQUEST: BannerScheduleInvalidRangeError,
        },
        () =>
          cms.updateBannerScheduleEnd(input.id, { endsAt: input.endsAt }, userId, {
            ip,
            userAgent,
          }),
      );
    }),

    listBannerSchedulesByPlacement: os.listBannerSchedulesByPlacement.handler(
      async ({ input, context }) => {
        await adminGuard.assert(context, 'content', 'update');
        return cms.listBannerSchedulesByPlacement(input.placement);
      },
    ),
  });
}
