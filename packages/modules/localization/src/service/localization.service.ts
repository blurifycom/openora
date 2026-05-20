import { Injectable, Inject } from '@nestjs/common';
import { PrismaService } from '@oss/persistence';
import { type EventBus, EVENT_BUS } from '@oss/core';

export class LocaleNotFoundError extends Error {
  constructor(code: string) {
    super(`Locale not found: ${code}`);
    this.name = 'LocaleNotFoundError';
  }
}

export class TranslationNotFoundError extends Error {
  constructor(id: string) {
    super(`Translation not found: ${id}`);
    this.name = 'TranslationNotFoundError';
  }
}

interface LocaleRow {
  id: string;
  code: string;
  name: string;
  isDefault: boolean;
}

interface TranslationRow {
  id: string;
  localeId: string;
  namespace: string;
  key: string;
  value: string;
  updatedAt: Date;
}

interface PrismaWithLocalization {
  locale: {
    findMany(): Promise<LocaleRow[]>;
    findUnique(args: { where: { code: string } }): Promise<LocaleRow | null>;
  };
  translation: {
    findMany(args: {
      where: { locale: { code: string }; namespace: string };
    }): Promise<TranslationRow[]>;
    upsert(args: {
      where: { localeId_namespace_key: { localeId: string; namespace: string; key: string } };
      create: { localeId: string; namespace: string; key: string; value: string };
      update: { value: string };
    }): Promise<TranslationRow>;
    findUnique(args: { where: { id: string } }): Promise<TranslationRow | null>;
    delete(args: { where: { id: string } }): Promise<TranslationRow>;
  };
}

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

@Injectable()
export class LocalizationService {
  private get db(): PrismaWithLocalization {
    return this.prisma as unknown as PrismaWithLocalization;
  }

  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
  ) {}

  async listLocales(): Promise<LocaleRow[]> {
    return this.db.locale.findMany();
  }

  async getTranslations(locale: string, namespace: string): Promise<Record<string, string>> {
    const rows = await this.db.translation.findMany({
      where: { locale: { code: locale }, namespace },
    });
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async upsertTranslation(input: UpsertTranslationInput): Promise<TranslationRecord> {
    const localeRow = await this.db.locale.findUnique({ where: { code: input.locale } });
    if (!localeRow) {
      throw new LocaleNotFoundError(input.locale);
    }

    const row = await this.db.translation.upsert({
      where: {
        localeId_namespace_key: {
          localeId: localeRow.id,
          namespace: input.namespace,
          key: input.key,
        },
      },
      create: {
        localeId: localeRow.id,
        namespace: input.namespace,
        key: input.key,
        value: input.value,
      },
      update: { value: input.value },
    });

    this.events.emit('localization.translation.upserted', {
      locale: input.locale,
      namespace: input.namespace,
      key: input.key,
    });

    return { ...row, updatedAt: row.updatedAt.toISOString() };
  }

  async deleteTranslation(id: string): Promise<{ success: true }> {
    const existing = await this.db.translation.findUnique({ where: { id } });
    if (!existing) {
      throw new TranslationNotFoundError(id);
    }
    await this.db.translation.delete({ where: { id } });
    this.events.emit('localization.translation.deleted', { id });
    return { success: true };
  }
}
