import { oc } from '@orpc/contract';
import * as z from 'zod';
import { IdInputSchema } from '@oss/shared-schemas';

const LocaleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  isDefault: z.boolean(),
});

const TranslationRecordSchema = z.object({
  id: z.string(),
  localeId: z.string(),
  namespace: z.string(),
  key: z.string(),
  value: z.string(),
  updatedAt: z.string(),
});

const UpsertTranslationInputSchema = z.object({
  locale: z.string(),
  namespace: z.string(),
  key: z.string(),
  value: z.string(),
});

export const localizationContract = {
  listLocales: oc
    .route({ method: 'GET', path: '/localization/locales' })
    .output(z.array(LocaleSchema)),

  getTranslations: oc
    .route({ method: 'GET', path: '/localization/translations/{locale}/{namespace}' })
    .input(z.object({ locale: z.string(), namespace: z.string() }))
    .output(z.record(z.string(), z.string())),

  upsertTranslation: oc
    .route({ method: 'POST', path: '/localization/translations' })
    .input(UpsertTranslationInputSchema)
    .output(TranslationRecordSchema),

  deleteTranslation: oc
    .route({ method: 'DELETE', path: '/localization/translations/{id}' })
    .input(IdInputSchema)
    .output(z.object({ success: z.literal(true) })),
};
