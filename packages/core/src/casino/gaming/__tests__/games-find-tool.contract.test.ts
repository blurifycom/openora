import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { GameCategoriesInputSchema, GamesFindInputSchema } from '../contract/index.js';

describe('games.find input', () => {
  const parse = (input: unknown) => z.safeParse(GamesFindInputSchema, input);

  it('defaults to 20 games and takes a limit from 1 to 50', () => {
    expect(parse({})).toEqual({ success: true, data: { limit: 20 } });
    expect(parse({ limit: '50' }).success).toBe(true);
    expect(parse({ limit: 0 }).success).toBe(false);
    expect(parse({ limit: 51 }).success).toBe(false);
  });

  it('takes a bounded search and only the review statuses and game types it knows', () => {
    expect(parse({ search: 'x'.repeat(100), reviewStatus: ['pending', 'declined'] }).success).toBe(
      true,
    );
    expect(parse({ search: 'x'.repeat(101) }).success).toBe(false);
    expect(parse({ search: '   ' }).success).toBe(false);
    expect(parse({ reviewStatus: ['live'] }).success).toBe(false);
    expect(parse({ gameType: 'lottery' }).success).toBe(false);
    expect(parse({ gameCategoryId: 'slots' }).success).toBe(false);
  });
});

describe('games.categories input', () => {
  it('narrows only by whether a category is switched on', () => {
    expect(z.safeParse(GameCategoriesInputSchema, {})).toEqual({ success: true, data: {} });
    expect(z.safeParse(GameCategoriesInputSchema, { active: false }).success).toBe(true);
    expect(z.safeParse(GameCategoriesInputSchema, { active: 'maybe' }).success).toBe(false);
  });
});
