import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { localizationContract } from '@oss/orpc-contract/localization';
import {
  LocalizationService,
  LocaleNotFoundError,
  TranslationNotFoundError,
} from '../service/localization.service.js';
import { ORPCError } from '@orpc/server';

@Controller()
export class LocalizationController {
  constructor(private readonly localization: LocalizationService) {}

  @Implement(localizationContract)
  router() {
    return {
      listLocales: implement(localizationContract.listLocales).handler(() => {
        return this.localization.listLocales();
      }),

      getTranslations: implement(localizationContract.getTranslations).handler(({ input }) => {
        return this.localization.getTranslations(input.locale, input.namespace);
      }),

      upsertTranslation: implement(localizationContract.upsertTranslation).handler(
        async ({ input }) => {
          try {
            return await this.localization.upsertTranslation(input);
          } catch (err) {
            if (err instanceof LocaleNotFoundError) {
              throw new ORPCError('NOT_FOUND', { message: err.message });
            }
            throw err;
          }
        },
      ),

      deleteTranslation: implement(localizationContract.deleteTranslation).handler(
        async ({ input }) => {
          try {
            return await this.localization.deleteTranslation(input.id);
          } catch (err) {
            if (err instanceof TranslationNotFoundError) {
              throw new ORPCError('NOT_FOUND', { message: err.message });
            }
            throw err;
          }
        },
      ),
    };
  }
}
