import { describe, expect, it } from 'vitest';
import { lobbyContract, ReplaceLobbyLayoutInputSchema } from '../contract/index.js';

describe('ReplaceLobbyLayoutInputSchema', () => {
  it('accepts arbitrary operator-defined section types with JSON object config', () => {
    expect(
      ReplaceLobbyLayoutInputSchema.safeParse({
        version: 0,
        sections: [
          {
            type: 'promotion-carousel',
            config: { title: 'Promotions', campaignIds: ['one', 'two'] },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects invalid type names, non-object config, and explicit sort order', () => {
    const invalidSections = [
      { type: 'Invalid Type', config: {} },
      { type: 'hero', config: [] },
      { type: 'hero', config: {}, sortOrder: 2 },
    ];
    for (const section of invalidSections) {
      expect(
        ReplaceLobbyLayoutInputSchema.safeParse({ version: 0, sections: [section] }).success,
      ).toBe(false);
    }
  });
});

describe('lobbyContract', () => {
  it('exports legacy public, layout, and admin routes from one typed contract', () => {
    expect(Object.keys(lobbyContract)).toEqual([
      'listCategories',
      'getCategoryBySlug',
      'getFeatured',
      'search',
      'getLayout',
      'getAdminLayout',
      'replaceLayout',
    ]);
  });
});
