import { DrizzleService, findOneOrThrow } from '@oss/db';
import { type EventBus, makeNotFoundError, serializeRow } from '@oss/core';
import { eq, and } from 'drizzle-orm';
import { locale, translation } from '../schema/index.js';

export const LocaleNotFoundError = makeNotFoundError('Locale');

export const TranslationNotFoundError = makeNotFoundError('Translation');

export interface UpsertTranslationInput {
  locale: string;
  namespace: string;
  key: string;
  value: string;
}

export interface TranslationRecord {
  id: string;
  localeId: string;
  namespace: string;
  key: string;
  value: string;
  updatedAt: string;
}

export class LocalizationService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
  ) {}

  async listLocales() {
    return this.drizzle.db.select().from(locale);
  }

  async getTranslations(localeCode: string, namespace: string): Promise<Record<string, string>> {
    const rows = await this.drizzle.db
      .select({ key: translation.key, value: translation.value })
      .from(translation)
      .innerJoin(locale, eq(translation.localeId, locale.id))
      .where(and(eq(locale.code, localeCode), eq(translation.namespace, namespace)));
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async upsertTranslation(input: UpsertTranslationInput): Promise<TranslationRecord> {
    const localeRow = findOneOrThrow(
      await this.drizzle.db.select().from(locale).where(eq(locale.code, input.locale)),
      new LocaleNotFoundError(input.locale),
    );

    const [row] = await this.drizzle.db
      .insert(translation)
      .values({
        localeId: localeRow.id,
        namespace: input.namespace,
        key: input.key,
        value: input.value,
      })
      .onConflictDoUpdate({
        target: [translation.localeId, translation.namespace, translation.key],
        set: { value: input.value },
      })
      .returning();

    this.events.emit('localization.translation.upserted', {
      locale: input.locale,
      namespace: input.namespace,
      key: input.key,
    });

    return serializeRow(row!, { dateFields: ['updatedAt'] }) as TranslationRecord;
  }

  async deleteTranslation(id: string): Promise<{ success: true }> {
    findOneOrThrow(
      await this.drizzle.db.select().from(translation).where(eq(translation.id, id)),
      new TranslationNotFoundError(id),
    );
    await this.drizzle.db.delete(translation).where(eq(translation.id, id));
    this.events.emit('localization.translation.deleted', { id });
    return { success: true };
  }
}
