import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LocalizationService,
  LocaleNotFoundError,
  TranslationNotFoundError,
} from '../service/localization.service.js';

function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    locale: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    translation: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      findUnique: vi.fn().mockResolvedValue(null),
      delete: vi.fn(),
    },
    ...overrides,
  };
}

function makeEvents() {
  return { emit: vi.fn() };
}

describe('LocalizationService', () => {
  let prisma: ReturnType<typeof makePrisma>;
  let events: ReturnType<typeof makeEvents>;
  let service: LocalizationService;

  beforeEach(() => {
    prisma = makePrisma();
    events = makeEvents();
    service = new LocalizationService(prisma as never, events as never);
  });

  describe('listLocales', () => {
    it('returns all locales from db', async () => {
      const locales = [{ id: '1', code: 'en', name: 'English', isDefault: true }];
      prisma.locale.findMany.mockResolvedValue(locales);
      const result = await service.listLocales();
      expect(result).toEqual(locales);
    });
  });

  describe('getTranslations', () => {
    it('returns a key-value map', async () => {
      prisma.translation.findMany.mockResolvedValue([
        {
          id: 't1',
          localeId: 'l1',
          namespace: 'common',
          key: 'hello',
          value: 'Hello',
          updatedAt: new Date(),
        },
      ]);
      const result = await service.getTranslations('en', 'common');
      expect(result).toEqual({ hello: 'Hello' });
    });
  });

  describe('upsertTranslation', () => {
    it('throws LocaleNotFoundError when locale does not exist', async () => {
      prisma.locale.findUnique.mockResolvedValue(null);
      await expect(
        service.upsertTranslation({
          locale: 'xx',
          namespace: 'common',
          key: 'hello',
          value: 'Hello',
        }),
      ).rejects.toBeInstanceOf(LocaleNotFoundError);
    });

    it('returns a translation record on success', async () => {
      const now = new Date();
      prisma.locale.findUnique.mockResolvedValue({
        id: 'l1',
        code: 'en',
        name: 'English',
        isDefault: true,
      });
      prisma.translation.upsert.mockResolvedValue({
        id: 't1',
        localeId: 'l1',
        namespace: 'common',
        key: 'hello',
        value: 'Hello',
        updatedAt: now,
      });
      const result = await service.upsertTranslation({
        locale: 'en',
        namespace: 'common',
        key: 'hello',
        value: 'Hello',
      });
      expect(result.id).toBe('t1');
      expect(result.updatedAt).toBe(now.toISOString());
      expect(events.emit).toHaveBeenCalledWith(
        'localization.translation.upserted',
        expect.objectContaining({ key: 'hello' }),
      );
    });
  });

  describe('deleteTranslation', () => {
    it('throws TranslationNotFoundError when translation does not exist', async () => {
      prisma.translation.findUnique.mockResolvedValue(null);
      await expect(service.deleteTranslation('missing-id')).rejects.toBeInstanceOf(
        TranslationNotFoundError,
      );
    });

    it('deletes and returns success', async () => {
      const now = new Date();
      prisma.translation.findUnique.mockResolvedValue({ id: 't1', updatedAt: now });
      prisma.translation.delete.mockResolvedValue({ id: 't1', updatedAt: now });
      const result = await service.deleteTranslation('t1');
      expect(result).toEqual({ success: true });
      expect(events.emit).toHaveBeenCalledWith('localization.translation.deleted', { id: 't1' });
    });
  });
});
