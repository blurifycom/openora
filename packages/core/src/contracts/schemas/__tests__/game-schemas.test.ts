import { describe, expect, it } from 'vitest';
import {
  GameCategorySummarySchema,
  GameCategorySummaryWithTranslationsSchema,
  GameCategoryTranslationsSchema,
  GameTagBadgeSettingsSchema,
} from '../game.js';

describe('game category translations', () => {
  it('accepts BCP 47 language keys and bounded names', () => {
    const result = GameCategoryTranslationsSchema.safeParse({
      de: { name: 'Tischspiele' },
      'pt-BR': { name: 'Jogos de mesa' },
      'zh-Hant-TW': { name: 'Table games' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects malformed language keys and invalid category names', () => {
    for (const key of ['', 'd', 'de_DE', 'de-', '-de']) {
      expect(GameCategoryTranslationsSchema.safeParse({ [key]: { name: 'Slots' } }).success).toBe(
        false,
      );
    }
    expect(GameCategoryTranslationsSchema.safeParse({ de: { name: '' } }).success).toBe(false);
    expect(
      GameCategoryTranslationsSchema.safeParse({ de: { name: 'x'.repeat(129) } }).success,
    ).toBe(false);
  });

  it('keeps the base category summary compatible without translations', () => {
    const result = GameCategorySummarySchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'table-games',
      name: 'Table Games',
      icon: null,
      sortOrder: 0,
    });

    expect(result.success).toBe(true);
  });

  it('defaults missing translations on translated category summaries', () => {
    const result = GameCategorySummaryWithTranslationsSchema.safeParse({
      id: '00000000-0000-4000-8000-000000000001',
      slug: 'table-games',
      name: 'Table Games',
      icon: null,
      sortOrder: 0,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.translations).toEqual({});
    }
  });
});

describe('game tag badge settings', () => {
  it('defaults to the standard badge colors', () => {
    expect(GameTagBadgeSettingsSchema.parse({})).toEqual({
      badgeColor: '#3377ff',
      textColor: '#ffffff',
    });
  });

  it('accepts six-digit hex colors and rejects other formats', () => {
    expect(
      GameTagBadgeSettingsSchema.parse({ badgeColor: '#112233', textColor: '#ABCDEF' }),
    ).toEqual({ badgeColor: '#112233', textColor: '#ABCDEF' });
    expect(() =>
      GameTagBadgeSettingsSchema.parse({ badgeColor: 'white', textColor: '#ffffff' }),
    ).toThrow();
  });
});
