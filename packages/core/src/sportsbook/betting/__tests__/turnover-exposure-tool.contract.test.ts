import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import { TurnoverExposureInputSchema } from '../contract/index.js';
import bettingPlugin from '../plugin.js';

describe('sportsbook.turnover_exposure input', () => {
  const parse = (input: unknown) => z.safeParse(TurnoverExposureInputSchema, input);

  it('defaults to the 5 largest open bets', () => {
    expect(parse({})).toEqual({ success: true, data: { largestOpen: 5 } });
  });

  it('takes 0 to 20 open bets and at most 92 days', () => {
    expect(parse({ largestOpen: '0' }).success).toBe(true);
    expect(parse({ largestOpen: 21 }).success).toBe(false);
    expect(parse({ dateFrom: '2026-01-01', dateTo: '2026-04-02' }).success).toBe(true);
    expect(parse({ dateFrom: '2026-01-01', dateTo: '2026-04-03' }).success).toBe(false);
    expect(parse({ currency: 'US' }).success).toBe(false);
  });
});

describe('betting agent surface registration', () => {
  it('registers its read tools within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('betting');

    await bettingPlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual([
      'sportsbook.turnover_exposure',
      'sportsbook.promotion_report',
      'sportsbook.bets_find',
    ]);
  });
});
