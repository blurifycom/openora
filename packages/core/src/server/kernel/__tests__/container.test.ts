import { describe, it, expect, vi } from 'vitest';
import { createToken } from '@openora/core/contracts';
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

  it('refuses every later registration of a sealed token and keeps serving it', () => {
    const TOKEN = createToken<string>('kernel');
    const c = new Container();
    c.registerSealed(TOKEN, () => 'enforcing');
    expect(c.get(TOKEN)).toBe('enforcing');

    expect(() => c.register(TOKEN, () => 'replacement')).toThrow(
      '[container] Token "kernel" is sealed: it is bound once and never rebound.',
    );
    expect(() => c.registerUnsafe(TOKEN, () => 'replacement')).toThrow(/is sealed/);
    expect(() => c.registerSealed(TOKEN, () => 'replacement')).toThrow(/is sealed/);
    expect(c.get(TOKEN)).toBe('enforcing');
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
