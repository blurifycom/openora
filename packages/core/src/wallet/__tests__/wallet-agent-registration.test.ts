import { describe, it, expect } from 'vitest';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import walletPlugin from '../plugin.js';

describe('wallet agent surface registration', () => {
  it('registers wallet.activity and hold_withdrawal within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('wallet');

    await walletPlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual(['wallet.activity']);
    expect(registry.actions.getAll().map((action) => action.contract.id)).toEqual([
      'hold_withdrawal',
    ]);
  });
});
