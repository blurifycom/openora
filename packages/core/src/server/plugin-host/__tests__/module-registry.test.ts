import { describe, it, expect } from 'vitest';
import { Container } from '../../kernel/index.js';
import { createToken, createSealedToken } from '@openora/core/contracts';
import { ModuleRegistryImpl } from '../module-registry.js';

function newRegistry() {
  const container = new Container();
  return { container, reg: new ModuleRegistryImpl(container) };
}

describe('ModuleRegistryImpl', () => {
  it('provide() binds to the container (last-wins)', () => {
    const { container, reg } = newRegistry();
    const TOKEN = createToken<string>('svc');
    reg.provide(TOKEN, () => 'a');
    reg.provide(TOKEN, () => 'b');
    expect(container.get(TOKEN)).toBe('b');
  });

  it('provide() refuses to bind a sealed token', () => {
    const { reg } = newRegistry();
    const SEALED = createSealedToken<string>('rg-enforcement');
    expect(() => reg.provide(SEALED as never, () => 'x')).toThrow(/sealed token/i);
  });

  it('provideSealed() binds a sealed token exactly once', () => {
    const { container, reg } = newRegistry();
    const SEALED = createSealedToken<string>('audit-log-writer');
    reg.provideSealed(SEALED, () => 'canonical');
    expect(container.get(SEALED)).toBe('canonical');
  });

  it('provideSealed() rejects a second bind of the same sealed token', () => {
    const { reg } = newRegistry();
    const SEALED = createSealedToken<string>('audit-log-writer');
    reg.provideSealed(SEALED, () => 'canonical');
    expect(() => reg.provideSealed(SEALED, () => 'overlay-attempt')).toThrow(/already bound/i);
  });

  it('routers.add() rejects a duplicate namespace', () => {
    const { reg } = newRegistry();
    reg.routers.add('wallet', () => ({}) as never);
    expect(() => reg.routers.add('wallet', () => ({}) as never)).toThrow(/already registered/);
  });

  it('events.on() accumulates handlers per event', () => {
    const { reg } = newRegistry();
    const h1 = () => {};
    const h2 = () => {};
    reg.events.on('wallet.deposit.completed', h1);
    reg.events.on('wallet.deposit.completed', h2);
    expect(reg.events.getAll().get('wallet.deposit.completed')).toEqual([h1, h2]);
  });
});
