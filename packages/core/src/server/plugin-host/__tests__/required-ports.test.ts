import { describe, it, expect } from 'vitest';
import { Container } from '../../kernel/index.js';
import { createToken } from '@openora/core/contracts';
import { assertRequiredPorts } from '../load-plugins.js';
import type { Plugin } from '../define-plugin.js';

const WALLET_COMMANDS = createToken<{ debit: () => void }>('WALLET_COMMANDS');

const consumer: Plugin = {
  id: 'gaming',
  requiresPorts: [WALLET_COMMANDS],
  register: () => {},
};

describe('assertRequiredPorts (ADR-0024 boot fail-fast)', () => {
  it('passes when every required port is bound', () => {
    const container = new Container();
    container.register(WALLET_COMMANDS, () => ({ debit: () => {} }));
    expect(() => assertRequiredPorts([consumer], container)).not.toThrow();
  });

  it('throws an actionable error naming the plugin and the unbound port', () => {
    const container = new Container();
    expect(() => assertRequiredPorts([consumer], container)).toThrow(/gaming.*WALLET_COMMANDS/s);
  });

  it('is a no-op for plugins that declare no required ports', () => {
    const container = new Container();
    const plain: Plugin = { id: 'audit', register: () => {} };
    expect(() => assertRequiredPorts([plain], container)).not.toThrow();
  });
});
