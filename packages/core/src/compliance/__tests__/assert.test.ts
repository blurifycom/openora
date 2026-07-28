import { describe, it, expect } from 'vitest';
import { assertSealedServicesBound, type SealedContainerView } from '../assert.js';
import { IMPLEMENTED_SEALED_TOKENS } from '../sealed.js';

const containerWith = (bound: readonly symbol[]): SealedContainerView => ({
  has: (token) => bound.includes(token),
});

describe('assertSealedServicesBound', () => {
  it('passes when every implemented sealed service is bound', () => {
    expect(() => assertSealedServicesBound(containerWith(IMPLEMENTED_SEALED_TOKENS))).not.toThrow();
  });

  it('refuses an assembly missing a sealed service', () => {
    expect(() => assertSealedServicesBound(containerWith([]))).toThrow(/sealed services must be/);
  });

  it('names every missing service so the operator knows which module to enable', () => {
    try {
      assertSealedServicesBound(containerWith([]));
    } catch (err) {
      for (const token of IMPLEMENTED_SEALED_TOKENS) {
        expect((err as Error).message).toContain(token.description);
      }
      return;
    }
    throw new Error('expected assertSealedServicesBound to throw');
  });

  it('points at the regulatory citations', () => {
    expect(() => assertSealedServicesBound(containerWith([]))).toThrow(/sealed\.ts/);
  });

  it('ignores unrelated bindings', () => {
    const unrelated = Symbol('payment-adapter');

    expect(() => assertSealedServicesBound(containerWith([unrelated]))).toThrow();
  });
});
