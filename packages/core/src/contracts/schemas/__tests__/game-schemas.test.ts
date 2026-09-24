import { describe, expect, it } from 'vitest';
import {
  GameCategorySummarySchema,
  GameCategorySummaryWithTranslationsSchema,
  GameCategoryTranslationsSchema,
  GameTagMetadataSchema,
  GAME_TAG_METADATA_MAX_BYTES,
  GameSortParamsSchema,
  GAME_SORT_PARAMS_MAX_BYTES,
} from '../game.js';

describe('game tag metadata', () => {
  it('accepts any JSON value per key', () => {
    const result = GameTagMetadataSchema.safeParse({
      badgeColor: '#ff0000',
      weight: 10,
      pinned: true,
      note: null,
      icons: ['fire', 'star'],
      theme: { bg: '#000', fg: '#fff' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects values JSON cannot represent', () => {
    for (const value of [undefined, Number.NaN, new Date(), () => 'x']) {
      expect(GameTagMetadataSchema.safeParse({ theme: value }).success).toBe(false);
    }
  });

  it('bounds keys and serialized size', () => {
    expect(GameTagMetadataSchema.safeParse({ '': 'x' }).success).toBe(false);
    expect(GameTagMetadataSchema.safeParse({ ['k'.repeat(65)]: 'x' }).success).toBe(false);

    // {"t":"..."} adds 8 bytes around the value.
    const sized = (bytes: number) => ({ t: 'x'.repeat(bytes - 8) });
    expect(GameTagMetadataSchema.safeParse(sized(GAME_TAG_METADATA_MAX_BYTES)).success).toBe(true);
    expect(GameTagMetadataSchema.safeParse(sized(GAME_TAG_METADATA_MAX_BYTES + 1)).success).toBe(
      false,
    );
  });
});

describe('game sort params', () => {
  it('accepts a JSON object', () => {
    expect(
      GameSortParamsSchema.safeParse({ windowDays: 30, region: 'eu', tags: ['hot'] }).success,
    ).toBe(true);
  });

  it('rejects values JSON cannot represent', () => {
    for (const value of [undefined, Number.NaN, new Date(), () => 'x']) {
      expect(GameSortParamsSchema.safeParse({ window: value }).success).toBe(false);
    }
  });

  it('bounds serialized size', () => {
    // {"t":"..."} adds 8 bytes around the value.
    const sized = (bytes: number) => ({ t: 'x'.repeat(bytes - 8) });
    expect(GameSortParamsSchema.safeParse(sized(GAME_SORT_PARAMS_MAX_BYTES)).success).toBe(true);
    expect(GameSortParamsSchema.safeParse(sized(GAME_SORT_PARAMS_MAX_BYTES + 1)).success).toBe(
      false,
    );
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
