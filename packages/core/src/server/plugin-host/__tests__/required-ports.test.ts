import { describe, it, expect } from 'vitest';
import { Container } from '../../kernel/index.js';
import { createToken, type TokenCatalog } from '@openora/core/contracts';
import { assertRequiredPorts, unboundControlPorts, unboundOptionalPorts } from '../load-plugins.js';
import type { Plugin } from '../define-plugin.js';

const WALLET_COMMANDS = createToken<{ debit: () => void }>('WALLET_COMMANDS');
const GEO_CHECK = createToken<{ check: () => void }>('GEO_CHECK');
const RG_LIMITS = createToken<{ checkDeposit: () => void }>('RG_LIMITS');
const catalog = { WALLET_COMMANDS, GEO_CHECK, RG_LIMITS } satisfies TokenCatalog;

const consumer: Plugin<typeof catalog> = {
  id: 'gaming',
  requiresPorts: [WALLET_COMMANDS],
  register: () => {},
};

describe('assertRequiredPorts (ADR-0024 boot fail-fast)', () => {
  it('passes when every required port is bound', () => {
    const container = new Container<typeof catalog>();
    container.register(WALLET_COMMANDS, () => ({ debit: () => {} }));
    expect(() => assertRequiredPorts([consumer], container)).not.toThrow();
  });

  it('throws an actionable error naming the plugin and the unbound port', () => {
    const container = new Container<typeof catalog>();
    expect(() => assertRequiredPorts([consumer], container)).toThrow(/gaming.*WALLET_COMMANDS/s);
  });

  it('is a no-op for plugins that declare no required ports', () => {
    const container = new Container<typeof catalog>();
    const plain: Plugin<typeof catalog> = { id: 'audit', register: () => {} };
    expect(() => assertRequiredPorts([plain], container)).not.toThrow();
  });
});

describe('unboundOptionalPorts', () => {
  const identity: Plugin<typeof catalog> = {
    id: 'identity',
    optionalPorts: [{ port: GEO_CHECK, without: 'sign-in skips the country check' }],
    register: () => {},
  };

  it('names the plugin, the port and what the plugin skips without it', () => {
    const container = new Container<typeof catalog>();

    expect(unboundOptionalPorts([identity], container)).toEqual([
      { plugin: 'identity', port: 'GEO_CHECK', without: 'sign-in skips the country check' },
    ]);
  });

  it('is empty once the port is bound', () => {
    const container = new Container<typeof catalog>();
    container.register(GEO_CHECK, () => ({ check: () => {} }));

    expect(unboundOptionalPorts([identity], container)).toEqual([]);
  });
});

describe('unboundControlPorts', () => {
  const wallet: Plugin<typeof catalog> = {
    id: 'wallet',
    optionalPorts: [{ port: GEO_CHECK, without: 'nothing that matters here' }],
    controlPorts: [
      { port: RG_LIMITS, without: 'deposit limits go unenforced', boundBy: 'compliance' },
    ],
    register: () => {},
  };

  it('names the plugin, the port, what it skips and the module that binds the port', () => {
    const container = new Container<typeof catalog>();

    expect(unboundControlPorts([wallet], container)).toEqual([
      {
        owner: 'wallet',
        port: 'RG_LIMITS',
        without: 'deposit limits go unenforced',
        boundBy: 'compliance',
      },
    ]);
  });

  it('is empty once the port is bound', () => {
    const container = new Container<typeof catalog>();
    container.register(RG_LIMITS, () => ({ checkDeposit: () => {} }));

    expect(unboundControlPorts([wallet], container)).toEqual([]);
  });

  it('are logged with the optional ports', () => {
    const container = new Container<typeof catalog>();

    expect(unboundOptionalPorts([wallet], container).map(({ port }) => port)).toEqual([
      'GEO_CHECK',
      'RG_LIMITS',
    ]);
  });
});
