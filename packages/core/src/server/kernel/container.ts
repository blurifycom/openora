import {
  isSealedToken,
  type AnyToken,
  type TokenCatalog,
  type TokenValue,
} from '@openora/core/contracts';

// Functional DI container. Resolution is lazy and cached; last `register` for a
// token wins - overlays rebind adapters by registering after the default binding -
// until `registerSealed` binds it for good, or `closeSealedTokens` ends binding for
// every sealed token (`createSealedToken`) at the end of boot.
//
// Container itself is token-shape-agnostic (AnyToken, the shape Token AND
// SealedToken both share) - it's a type-erased-at-runtime symbol map. Who may bind a
// sealed token during boot is decided one layer up, in ModuleRegistry's
// provide()/provideSealed() (see plugin-host/module-registry.ts); this class keeps
// it bound.

export type Factory<T, C extends TokenCatalog> = (c: Container<C>) => T;

/**
 * Functional DI container - no decorators, no reflection. `get()` resolves
 * lazily and caches the instance for the container's lifetime; `register()`
 * for an already-resolved token clears the cached instance, so a later
 * `register()` (an overlay rebinding an adapter after the default plugin
 * loads) always wins on the next `get()`. A token bound with `registerSealed()`
 * is the exception: every later registration of it throws. Resolving a token
 * whose factory transitively depends on itself throws rather than recursing forever.
 * `dispose()` runs every `onDispose` callback in REVERSE registration order -
 * register dependencies before their dependents so teardown happens safely.
 */
export class Container<C extends TokenCatalog> {
  private readonly factories = new Map<symbol, Factory<unknown, C>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving = new Set<symbol>();
  private readonly sealed = new Set<symbol>();
  private sealedTokensClosed = false;
  private readonly disposers: Array<() => void | Promise<void>> = [];

  register<T extends C[keyof C]>(
    token: T,
    factory: (container: Container<C>) => TokenValue<T>,
  ): void {
    this.registerUnsafe(token, factory);
  }

  registerSealed<T extends C[keyof C]>(
    token: T,
    factory: (container: Container<C>) => TokenValue<T>,
  ): void {
    this.registerSealedUnsafe(token, factory);
  }

  /** `registerSealed` for a token outside the catalog type: what a plugin's `provideSealed` binds. */
  registerSealedUnsafe<T>(token: AnyToken<T>, factory: Factory<T, C>): void {
    this.registerUnsafe(token, factory);
    this.sealed.add(token);
  }

  /**
   * Ends binding for every sealed token (`createSealedToken`), bound or not: from here on any
   * registration of one throws. `createApp` calls it once the plugins and the composition root
   * have registered, so a holder of the container it returns can neither rebind a sealed service
   * a module bound nor bind one that none did.
   */
  closeSealedTokens(): void {
    this.sealedTokensClosed = true;
  }

  registerUnsafe<T>(token: AnyToken<T>, factory: Factory<T, C>): void {
    if (this.sealed.has(token) || (this.sealedTokensClosed && isSealedToken(token))) {
      throw new Error(
        `[container] Token "${token.description ?? String(token)}" is sealed: it is bound once and never rebound.`,
      );
    }
    this.factories.set(token, factory as Factory<unknown, C>);
    this.instances.delete(token);
  }

  has<T extends C[keyof C]>(token: T): boolean {
    return this.factories.has(token);
  }

  get<T extends C[keyof C]>(token: T): TokenValue<T> {
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
    try {
      const instance = factory(this) as TokenValue<T>;
      this.instances.set(token, instance);
      return instance;
    } finally {
      // A factory that refuses keeps refusing with its own error, not a circular dependency.
      this.resolving.delete(token);
    }
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
