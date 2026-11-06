import { describe, it, expect } from 'vitest';
import * as z from 'zod';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import { CmsBannersInputSchema } from '../contract/index.js';
import cmsPlugin from '../plugin.js';

describe('cms.banners input', () => {
  it('needs nothing, and narrows only to a bounded placement', () => {
    expect(z.safeParse(CmsBannersInputSchema, {})).toEqual({ success: true, data: {} });
    expect(z.safeParse(CmsBannersInputSchema, { placement: 'home-hero' }).success).toBe(true);
    expect(z.safeParse(CmsBannersInputSchema, { placement: '' }).success).toBe(false);
    expect(z.safeParse(CmsBannersInputSchema, { placement: 'x'.repeat(101) }).success).toBe(false);
  });
});

describe('cms agent surface registration', () => {
  it('registers cms.banners within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('cms');

    await cmsPlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual(['cms.banners']);
  });
});
