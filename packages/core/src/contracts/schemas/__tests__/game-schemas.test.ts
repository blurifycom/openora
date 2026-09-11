import { describe, expect, it } from 'vitest';
import {
  GameCategorySummarySchema,
  GameCategorySummaryWithTranslationsSchema,
  GameCategoryTranslationsSchema,
} from '../game.js';

describe('game category translations', () => {
  it('accepts uppercase ISO country keys and bounded names', () => {
    const result = GameCategoryTranslationsSchema.safeParse({
      DE: { name: 'Tischspiele' },
      FR: { name: 'Jeux de table' },
    });

    expect(result.success).toBe(true);
  });

  it('rejects invalid country keys and category names', () => {
    expect(GameCategoryTranslationsSchema.safeParse({ de: { name: 'Slots' } }).success).toBe(false);
    expect(GameCategoryTranslationsSchema.safeParse({ DE: { name: '' } }).success).toBe(false);
    expect(
      GameCategoryTranslationsSchema.safeParse({ DE: { name: 'x'.repeat(129) } }).success,
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
