import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  LocalizationService,
  LocaleNotFoundError,
  TranslationNotFoundError,
} from '../service/localization.service.js';

function chain(result: unknown): any {
  const proxy: any = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === 'then') return (res: (v: unknown) => unknown) => res(result);
      return () => proxy;
    },
    apply: () => proxy,
  });
  return proxy;
}

function makeDrizzle(r: { select?: unknown; insert?: unknown; delete?: unknown } = {}) {
  const db = {
    select: vi.fn(() => chain(r.select ?? [])),
    insert: vi.fn(() => chain(r.insert ?? [])),
    delete: vi.fn(() => chain(r.delete ?? [])),
  };
  return { db } as unknown as import('@oss/db').DrizzleService;
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

describe('LocalizationService', () => {
  let events: ReturnType<typeof makeEvents>;

  beforeEach(() => {
    events = makeEvents();
  });

  describe('listLocales', () => {
    it('returns all locales from db', async () => {
      const locales = [{ id: '1', code: 'en', name: 'English', isDefault: true }];
      const service = new LocalizationService(
        makeDrizzle({ select: locales }) as never,
        events as never,
      );
      const result = await service.listLocales();
      expect(result).toEqual(locales);
    });
  });

  describe('getTranslations', () => {
    it('returns a key-value map', async () => {
      const drizzle = makeDrizzle({ select: [{ key: 'hello', value: 'Hello' }] });
      const service = new LocalizationService(drizzle as never, events as never);
      const result = await service.getTranslations('en', 'common');
      expect(result).toEqual({ hello: 'Hello' });
    });
  });

  describe('upsertTranslation', () => {
    it('throws LocaleNotFoundError when locale does not exist', async () => {
      const service = new LocalizationService(
        makeDrizzle({ select: [] }) as never,
        events as never,
      );
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
      const drizzle = makeDrizzle({
        select: [{ id: 'l1', code: 'en', name: 'English', isDefault: true }],
        insert: [
          {
            id: 't1',
            localeId: 'l1',
            namespace: 'common',
            key: 'hello',
            value: 'Hello',
            updatedAt: now,
          },
        ],
      });
      const service = new LocalizationService(drizzle as never, events as never);
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
      const service = new LocalizationService(
        makeDrizzle({ select: [] }) as never,
        events as never,
      );
      await expect(service.deleteTranslation('missing-id')).rejects.toBeInstanceOf(
        TranslationNotFoundError,
      );
    });

    it('deletes and returns success', async () => {
      const now = new Date();
      const drizzle = makeDrizzle({ select: [{ id: 't1', updatedAt: now }] });
      const service = new LocalizationService(drizzle as never, events as never);
      const result = await service.deleteTranslation('t1');
      expect(result).toEqual({ success: true });
      expect(events.emit).toHaveBeenCalledWith('localization.translation.deleted', { id: 't1' });
    });
  });
});
