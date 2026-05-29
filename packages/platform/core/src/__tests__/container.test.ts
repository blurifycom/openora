import { describe, it, expect, vi } from 'vitest';
import { createToken } from '@oss/adapters';
import { Container } from '../container.js';

describe('Container', () => {
  it('resolves a registered factory and caches the instance', () => {
    const TOKEN = createToken<{ n: number }>('cache');
    const c = new Container();
    const factory = vi.fn(() => ({ n: 1 }));
    c.register(TOKEN, factory);

    const a = c.get(TOKEN);
    const b = c.get(TOKEN);

    expect(a).toBe(b); // same cached instance
    expect(factory).toHaveBeenCalledTimes(1); // lazy + memoized
  });

  it('last registration wins and drops the cached instance', () => {
    const TOKEN = createToken<string>('rebind');
    const c = new Container();
    c.register(TOKEN, () => 'first');
    expect(c.get(TOKEN)).toBe('first');

    c.register(TOKEN, () => 'second'); // overlay rebinds after first resolve
    expect(c.get(TOKEN)).toBe('second');
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
