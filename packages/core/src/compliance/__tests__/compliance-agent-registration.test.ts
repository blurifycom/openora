import { describe, it, expect } from 'vitest';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import compliancePlugin from '../plugin.js';

describe('compliance agent surface registration', () => {
  it('registers kyc.status and request_enhanced_kyc within the kernel contract rules', async () => {
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(new Container());
    registry.setOwner('compliance');

    await compliancePlugin.register(registry);

    expect(registry.mcp.getTools().map((tool) => tool.contract.id)).toEqual(['kyc.status']);
    expect(registry.actions.getAll().map((action) => action.contract.id)).toEqual([
      'request_enhanced_kyc',
    ]);
  });
});
