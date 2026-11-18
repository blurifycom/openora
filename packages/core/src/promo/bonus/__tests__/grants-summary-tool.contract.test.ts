import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import { GrantsSummaryInputSchema } from '../contract/index.js';
import bonusPlugin from '../plugin.js';

describe('bonus.grants_summary input', () => {
  const parse = (input: unknown) => z.safeParse(GrantsSummaryInputSchema, input);

  it('needs nothing, and narrows only by a currency or a source it knows', () => {
    expect(parse({})).toEqual({ success: true, data: {} });
    expect(parse({ source: 'cashback', currency: 'usdt' }).success).toBe(true);
    expect(parse({ source: 'loyalty' }).success).toBe(false);
  });

  it('spans at most 366 days', () => {
    expect(parse({ dateFrom: '2025-01-01', dateTo: '2026-01-01' }).success).toBe(true);
    expect(parse({ dateFrom: '2025-01-01', dateTo: '2026-01-02' }).success).toBe(false);
  });
});

describe('bonus agent surface registration', () => {
  it('registers bonus.grants_summary within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('bonus');

    await bonusPlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual([
      'bonus.grants_summary',
    ]);
  });
});
