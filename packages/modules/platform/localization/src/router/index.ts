import { implement } from '@orpc/server';
import { AdminGuard } from '@oss/auth';
import { mapErrors, type OssContext } from '@oss/core';
import { localizationContract } from '@oss/orpc-contract/localization';
import {
  LocalizationService,
  LocaleNotFoundError,
  TranslationNotFoundError,
} from '../service/localization.service.js';

export function createLocalizationRouter(
  localization: LocalizationService,
  adminGuard: AdminGuard,
) {
  const os = implement(localizationContract).$context<OssContext>();

  return os.router({
    listLocales: os.listLocales.handler(() => localization.listLocales()),

    getTranslations: os.getTranslations.handler(({ input }) =>
      localization.getTranslations(input.locale, input.namespace),
    ),

    upsertTranslation: os.upsertTranslation.handler(async ({ input, context }) => {
      await adminGuard.assert(context);
      return mapErrors({ NOT_FOUND: LocaleNotFoundError }, () =>
        localization.upsertTranslation(input),
      );
    }),

    deleteTranslation: os.deleteTranslation.handler(async ({ input, context }) => {
      await adminGuard.assert(context);
      return mapErrors({ NOT_FOUND: TranslationNotFoundError }, () =>
        localization.deleteTranslation(input.id),
      );
    }),
  });
}
