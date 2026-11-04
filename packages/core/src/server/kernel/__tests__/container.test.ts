import { describe, it, expect, vi } from 'vitest';
import { createSealedToken, createToken } from '@openora/core/contracts';
import { Container } from '../container.js';

describe('Container', () => {
  it('resolves a registered factory and caches the instance', () => {
    const TOKEN = createToken<{ n: number }>('cache');
    const c = new Container();
    const factory = vi.fn(() => ({ n: 1 }));
    c.register(TOKEN, factory);

    const a = c.get(TOKEN);
    const b = c.get(TOKEN);

    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('last registration wins and drops the cached instance', () => {
    const TOKEN = createToken<string>('rebind');
    const c = new Container();
    c.register(TOKEN, () => 'first');
    expect(c.get(TOKEN)).toBe('first');

    c.register(TOKEN, () => 'second');
    expect(c.get(TOKEN)).toBe('second');
  });

  describe('a token bound with registerSealed', () => {
    const sealedKernel = () => {
      const TOKEN = createToken<string>('kernel');
      const c = new Container();
      c.registerSealed(TOKEN, () => 'enforcing');
      expect(c.get(TOKEN)).toBe('enforcing');
      return { TOKEN, c };
    };

    it('refuses a later register, and keeps serving the binding', () => {
      const { TOKEN, c } = sealedKernel();
      expect(() => c.register(TOKEN, () => 'replacement')).toThrow(
        '[container] Token "kernel" is sealed: it is bound once and never rebound.',
      );
      expect(c.get(TOKEN)).toBe('enforcing');
    });

    it('refuses a later registerUnsafe, and keeps serving the binding', () => {
      const { TOKEN, c } = sealedKernel();
      expect(() => c.registerUnsafe(TOKEN, () => 'replacement')).toThrow(/is sealed/);
      expect(c.get(TOKEN)).toBe('enforcing');
    });

    it('refuses a later registerSealed or registerSealedUnsafe, and keeps serving the binding', () => {
      const { TOKEN, c } = sealedKernel();
      expect(() => c.registerSealed(TOKEN, () => 'replacement')).toThrow(/is sealed/);
      expect(() => c.registerSealedUnsafe(TOKEN, () => 'replacement')).toThrow(/is sealed/);
      expect(c.get(TOKEN)).toBe('enforcing');
    });
  });

  describe('closeSealedTokens', () => {
    it('refuses every registration of a sealed token, bound or not, and keeps serving the bound', () => {
      const BOUND = createSealedToken<string>('audit-writer');
      const UNBOUND = createSealedToken<string>('rg-enforcement');
      const c = new Container();
      c.registerSealedUnsafe(BOUND, () => 'canonical');

      c.closeSealedTokens();

      for (const token of [BOUND, UNBOUND]) {
        expect(() => c.registerUnsafe(token, () => 'replacement')).toThrow(
          `[container] Token "${token.description}" is sealed: it is bound once and never rebound.`,
        );
        expect(() => c.registerSealedUnsafe(token, () => 'replacement')).toThrow(/is sealed/);
      }
      expect(c.get(BOUND)).toBe('canonical');
      expect(c.has(UNBOUND)).toBe(false);
    });

    it('leaves the ordinary tokens to the last registration', () => {
      const ADAPTER = createToken<string>('payment-adapter');
      const c = new Container();
      c.register(ADAPTER, () => 'default');

      c.closeSealedTokens();
      c.register(ADAPTER, () => 'overlay');

      expect(c.get(ADAPTER)).toBe('overlay');
    });
  });

  it('lets a sealed registration replace an earlier ordinary one', () => {
    const TOKEN = createToken<string>('kernel');
    const c = new Container();
    c.register(TOKEN, () => 'overlay');

    c.registerSealed(TOKEN, () => 'enforcing');

    expect(c.get(TOKEN)).toBe('enforcing');
  });

  it('throws for an unregistered token', () => {
    const c = new Container();
    expect(() => c.get(createToken('missing'))).toThrow(/No provider registered/);
  });

  it('detects circular dependencies', () => {
    const A = createToken('a');
    const B = createToken('b');
    const c = new Container();
    c.register(A, (cc) => cc.get(B));
    c.register(B, (cc) => cc.get(A));
    expect(() => c.get(A)).toThrow(/Circular dependency/);
  });

  it('runs disposers in reverse registration order', async () => {
    const c = new Container();
    const order: string[] = [];
    c.onDispose(() => {
      order.push('first');
    });
    c.onDispose(() => {
      order.push('second');
    });
    await c.dispose();
    expect(order).toEqual(['second', 'first']);
  });
});
