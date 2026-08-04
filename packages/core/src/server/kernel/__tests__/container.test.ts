import { describe, it, expect, vi } from 'vitest';
import { createToken, type TokenCatalog } from '@openora/core/contracts';
import { createContainer } from '../container.js';

const CACHE = createToken<{ n: number }>('cache');
const REBIND = createToken<string>('rebind');
const MISSING = createToken('missing');
const A = createToken('a');
const B = createToken('b');
const catalog = { CACHE, REBIND, MISSING, A, B } satisfies TokenCatalog;

describe('Container', () => {
  it('resolves a registered factory and caches the instance', () => {
    const c = createContainer(catalog);
    const factory = vi.fn(() => ({ n: 1 }));
    c.register(CACHE, factory);

    const a = c.get(CACHE);
    const b = c.get(CACHE);

    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('last registration wins and drops the cached instance', () => {
    const c = createContainer(catalog);
    c.register(REBIND, () => 'first');
    expect(c.get(REBIND)).toBe('first');

    c.register(REBIND, () => 'second');
    expect(c.get(REBIND)).toBe('second');
  });

  it('throws for an unregistered token', () => {
    const c = createContainer(catalog);
    expect(() => c.get(MISSING)).toThrow(/No provider registered/);
  });

  it('detects circular dependencies', () => {
    const c = createContainer(catalog);
    c.register(A, (cc) => cc.get(B));
    c.register(B, (cc) => cc.get(A));
    expect(() => c.get(A)).toThrow(/Circular dependency/);
  });

  it('runs disposers in reverse registration order', async () => {
    const c = createContainer(catalog);
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
