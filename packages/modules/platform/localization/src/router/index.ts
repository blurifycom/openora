import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { AdminGuard } from '@oss/auth';
import { mapErrors } from '@oss/core';
import { localizationContract } from '@oss/orpc-contract/localization';
import {
  LocalizationService,
  LocaleNotFoundError,
  TranslationNotFoundError,
} from '../service/localization.service.js';

@Controller()
export class LocalizationController {
  constructor(
    private readonly localization: LocalizationService,
    private readonly adminGuard: AdminGuard,
  ) {}

  @Implement(localizationContract)
  router() {
    return {
      listLocales: implement(localizationContract.listLocales).handler(() =>
        this.localization.listLocales(),
      ),

      getTranslations: implement(localizationContract.getTranslations).handler(({ input }) =>
        this.localization.getTranslations(input.locale, input.namespace),
      ),

      upsertTranslation: implement(localizationContract.upsertTranslation).handler(
        async ({ input, context }) => {
          await this.adminGuard.assert(context);
          return mapErrors(
            { NOT_FOUND: LocaleNotFoundError },
            () => this.localization.upsertTranslation(input),
          );
        },
      ),

      deleteTranslation: implement(localizationContract.deleteTranslation).handler(
        async ({ input, context }) => {
          await this.adminGuard.assert(context);
          return mapErrors(
            { NOT_FOUND: TranslationNotFoundError },
            () => this.localization.deleteTranslation(input.id),
          );
        },
      ),
    };
  }
}
