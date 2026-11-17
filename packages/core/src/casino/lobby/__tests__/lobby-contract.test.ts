import { describe, expect, it } from 'vitest';
import {
  lobbyContract,
  LobbyLayoutKeyInputSchema,
  ReplaceLobbyLayoutInputSchema,
} from '../contract/index.js';

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

describe('lobby layout key input', () => {
  it('defaults to the global layout when omitted', () => {
    expect(LobbyLayoutKeyInputSchema.parse({})).toEqual({ layoutKey: 'global' });
    expect(ReplaceLobbyLayoutInputSchema.parse({ version: 0, sections: [] })).toMatchObject({
      layoutKey: 'global',
    });
  });

  it('accepts consumer-defined slugs', () => {
    for (const layoutKey of ['home', 'casino-lobby', 'a', 'x'.repeat(40), 'promo-2']) {
      expect(LobbyLayoutKeyInputSchema.safeParse({ layoutKey }).success).toBe(true);
    }
  });

  it('rejects keys that are not short lowercase slugs', () => {
    for (const layoutKey of [
      '',
      'Home',
      'home page',
      'home_page',
      '-home',
      'home-',
      'a--b',
      'x'.repeat(41),
      'lobby:layout',
    ]) {
      expect(LobbyLayoutKeyInputSchema.safeParse({ layoutKey }).success).toBe(false);
      expect(
        ReplaceLobbyLayoutInputSchema.safeParse({ layoutKey, version: 0, sections: [] }).success,
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
