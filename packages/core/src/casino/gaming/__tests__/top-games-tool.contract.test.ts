import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import { TopGamesInputSchema } from '../contract/index.js';
import gamingPlugin from '../plugin.js';

describe('gaming.top_games input', () => {
  const parse = (input: unknown) => z.safeParse(TopGamesInputSchema, input);

  it('defaults to the 10 games with the most volume', () => {
    expect(parse({})).toEqual({
      success: true,
      data: { sortBy: 'volume', sortDir: 'desc', limit: 10 },
    });
  });

  it('takes a limit from 1 to 50 and sorts only by the figures it returns', () => {
    expect(parse({ limit: '50', sortBy: 'revenue', sortDir: 'asc' }).success).toBe(true);
    expect(parse({ limit: 0 }).success).toBe(false);
    expect(parse({ limit: 51 }).success).toBe(false);
    expect(parse({ sortBy: 'name' }).success).toBe(false);
    expect(parse({ gameType: 'lottery' }).success).toBe(false);
  });

  it('spans at most 92 days', () => {
    expect(parse({ dateFrom: '2026-01-01', dateTo: '2026-04-02' }).success).toBe(true);
    expect(parse({ dateFrom: '2026-01-01', dateTo: '2026-04-03' }).success).toBe(false);
  });
});

describe('gaming agent surface registration', () => {
  it('registers gaming.top_games within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('gaming');

    await gamingPlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual(['gaming.top_games']);
  });
});
