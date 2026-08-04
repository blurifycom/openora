import type { TokenCatalog, TokenValue } from '@openora/core/contracts';

// Functional DI container. Resolution is lazy and cached; last `register` for a
// token wins - overlays rebind adapters by registering after the default binding.
//
// Container itself is token-shape-agnostic (AnyToken, the shape Token AND
// SealedToken both share) - it's a type-erased-at-runtime symbol map. The
// sealed/overlay-rejection rules live one layer up, in ModuleRegistry's
// provide()/provideSealed() (see plugin-host/module-registry.ts).

export type Factory<T, C extends TokenCatalog> = (c: Container<C>) => T;

/**
 * Functional DI container - no decorators, no reflection. `get()` resolves
 * lazily and caches the instance for the container's lifetime; `register()`
 * for an already-resolved token clears the cached instance, so a later
 * `register()` (an overlay rebinding an adapter after the default plugin
 * loads) always wins on the next `get()`. Resolving a token whose factory
 * transitively depends on itself throws rather than recursing forever.
 * `dispose()` runs every `onDispose` callback in REVERSE registration order -
 * register dependencies before their dependents so teardown happens safely.
 */
export class Container<C extends TokenCatalog> {
  private readonly factories = new Map<symbol, Factory<unknown, C>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving = new Set<symbol>();
  private readonly disposers: Array<() => void | Promise<void>> = [];

  private constructor(_catalog: C) {}

  static create<const C extends TokenCatalog>(catalog: C): Container<C> {
    return new Container(catalog);
  }

  register<T extends C[keyof C]>(
    token: T,
    factory: (container: Container<C>) => TokenValue<T>,
  ): void {
    this.factories.set(token, factory);
    this.instances.delete(token);
  }

  has<T extends C[keyof C]>(token: T): boolean;
  has(token: C[keyof C]): boolean {
    return this.factories.has(token);
  }

  get<T extends C[keyof C]>(token: T): TokenValue<T>;
  get<T>(token: C[keyof C]): T {
    if (this.instances.has(token)) {
      return this.instances.get(token) as T;
    }

    const factory = this.factories.get(token);
    if (!factory) {
      throw new Error(`No provider registered for token "${token.description ?? String(token)}"`);
    }
    if (this.resolving.has(token)) {
      throw new Error(
        `Circular dependency resolving token "${token.description ?? String(token)}"`,
      );
    }

    this.resolving.add(token);
    const instance = factory(this) as T;
    this.resolving.delete(token);
    this.instances.set(token, instance);
    return instance;
  }

  onDispose(fn: () => void | Promise<void>): void {
    this.disposers.push(fn);
  }

  async dispose(): Promise<void> {
    for (const fn of [...this.disposers].reverse()) {
      await fn();
    }
  }
}

/** Creates a container whose token catalog is inferred from the catalog value. */
export function createContainer<const C extends TokenCatalog>(catalog: C): Container<C> {
  return Container.create(catalog);
}
