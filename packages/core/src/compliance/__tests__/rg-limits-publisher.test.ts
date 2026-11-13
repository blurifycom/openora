import { describe, it, expect } from 'vitest';
import { RG_LIMITS_PUBLISHER, type RgLimitsPublisherPort } from '@openora/core/contracts';
import { Container, ModuleRegistryImpl, type CoreTokenCatalog } from '@openora/core/server';
import compliancePlugin from '../plugin.js';

describe('the limits publisher is sealed', () => {
  it('refuses an overlay rebinding it after compliance bound it', async () => {
    const container = new Container<CoreTokenCatalog>();
    const registry = new ModuleRegistryImpl<CoreTokenCatalog>(container);
    await compliancePlugin.register(registry);
    const noop: RgLimitsPublisherPort = { publish: async () => {} };

    expect(() =>
      // @ts-expect-error The type already refuses a sealed token; the runtime must too.
      registry.provide(RG_LIMITS_PUBLISHER, () => noop),
    ).toThrow(/Refusing to bind a sealed token/);
    expect(() => registry.provideSealed(RG_LIMITS_PUBLISHER, () => noop)).toThrow(/already bound/);
    expect(() => container.register(RG_LIMITS_PUBLISHER, () => noop)).toThrow(/is sealed/);
  });
});
