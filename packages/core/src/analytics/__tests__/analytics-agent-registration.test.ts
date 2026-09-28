import { describe, it, expect } from 'vitest';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import analyticsPlugin from '../plugin.js';

describe('analytics agent surface registration', () => {
  it('registers ggr.summary within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('analytics');

    await analyticsPlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual(['ggr.summary']);
    expect(registry.actions.getAll().map((action) => action.contract.id)).toEqual([]);
  });
});
