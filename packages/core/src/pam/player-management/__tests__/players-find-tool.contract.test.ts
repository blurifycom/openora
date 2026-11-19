import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import { PlayersFindInputSchema } from '../contract/index.js';
import playerManagementPlugin from '../plugin.js';

describe('players.find input', () => {
  const parse = (input: unknown) => z.safeParse(PlayersFindInputSchema, input);

  it('defaults to the 20 players registered most recently', () => {
    expect(parse({})).toEqual({
      success: true,
      data: { sortBy: 'registeredAt', sortDir: 'desc', limit: 20 },
    });
  });

  it('takes a limit from 1 to 50 and at most 10 tags', () => {
    expect(parse({ limit: '50', tagKeys: ['vip', 'high_roller'] }).success).toBe(true);
    expect(parse({ limit: 0 }).success).toBe(false);
    expect(parse({ limit: 51 }).success).toBe(false);
    expect(parse({ tagKeys: Array.from({ length: 11 }, () => 'vip') }).success).toBe(false);
  });

  it('takes a two-letter country, a decimal deposit threshold and ordered days', () => {
    expect(parse({ country: 'mt', minTotalDeposits: '100.50' }).success).toBe(true);
    expect(parse({ country: 'MLT' }).success).toBe(false);
    expect(parse({ minTotalDeposits: '1e3' }).success).toBe(false);
    expect(parse({ lastSeenFrom: '2026-01-02', lastSeenTo: '2026-01-01' }).success).toBe(false);
    expect(parse({ registeredTo: '2026-01-01' }).success).toBe(true);
  });
});

describe('player-management agent surface registration', () => {
  it('registers player.summary and players.find within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('player-management');

    await playerManagementPlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual([
      'player.summary',
      'players.find',
    ]);
  });
});
