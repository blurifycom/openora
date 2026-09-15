import { describe, expect, it } from 'vitest';
import {
  GameCategorySummarySchema,
  GameCategorySummaryWithTranslationsSchema,
  GameCategoryTranslationsSchema,
  GameTagMetadataSchema,
  GAME_TAG_METADATA_MAX_ENTRIES,
} from '../game.js';

describe('game tag metadata', () => {
  it('accepts a flat map of strings', () => {
    const result = GameTagMetadataSchema.safeParse({ badgeColor: '#ff0000', icon: 'fire' });

    expect(result.success).toBe(true);
  });

  it('rejects non-string values', () => {
    for (const value of [10, true, null, ['fire'], { bg: '#000' }]) {
      expect(GameTagMetadataSchema.safeParse({ theme: value }).success).toBe(false);
    }
  });

  it('bounds keys, values, and entry count', () => {
    expect(GameTagMetadataSchema.safeParse({ '': 'x' }).success).toBe(false);
    expect(GameTagMetadataSchema.safeParse({ ['k'.repeat(65)]: 'x' }).success).toBe(false);
    expect(GameTagMetadataSchema.safeParse({ theme: 'x'.repeat(513) }).success).toBe(false);

    const entries = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`key${i}`, 'x']));
    expect(GameTagMetadataSchema.safeParse(entries(GAME_TAG_METADATA_MAX_ENTRIES)).success).toBe(
      true,
    );
    expect(
      GameTagMetadataSchema.safeParse(entries(GAME_TAG_METADATA_MAX_ENTRIES + 1)).success,
    ).toBe(false);
  });
});

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
