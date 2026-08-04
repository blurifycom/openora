import type { AnyToken, TokenCatalog, TokenValue } from '@openora/core/contracts';

// Functional DI container. Resolution is lazy and cached; last `register` for a
// token wins - overlays rebind adapters by registering after the default binding.
//
// Container itself is token-shape-agnostic (AnyToken, the shape Token AND
// SealedToken both share) - it's a type-erased-at-runtime symbol map. The
// sealed/overlay-rejection rules live one layer up, in ModuleRegistry's
// provide()/provideSealed() (see plugin-host/module-registry.ts).

export type Factory<T, C extends TokenCatalog = never> = (c: Container<C>) => T;

// The token shape register()/has()/get() accept: any token when uncatalogued, or a
// catalog-listed one otherwise. T is inferred directly from the token argument
// (never a keyof reverse lookup), which is what makes TokenValue<T> resolve to
// that one entry instead of a union of every catalog value.
type ContainerToken<C extends TokenCatalog> = [C] extends [never] ? AnyToken<unknown> : C[keyof C];

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
export class Container<C extends TokenCatalog = never> {
  private readonly factories = new Map<symbol, Factory<unknown, C>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving = new Set<symbol>();
  private readonly disposers: Array<() => void | Promise<void>> = [];

  register<T extends ContainerToken<C>>(
    token: T,
    factory: (container: Container<C>) => TokenValue<T>,
  ): void {
    this.registerUnsafe(token, factory);
  }

  registerUnsafe<T>(token: AnyToken<T>, factory: Factory<T, C>): void {
    this.factories.set(token, factory as Factory<unknown, C>);
    this.instances.delete(token);
  }

  has<T extends ContainerToken<C>>(token: T): boolean {
    return this.factories.has(token);
  }

  get<T extends ContainerToken<C>>(token: T): TokenValue<T> {
    if (this.instances.has(token)) {
      return this.instances.get(token) as TokenValue<T>;
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
    const instance = factory(this) as TokenValue<T>;
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
