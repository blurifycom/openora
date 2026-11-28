import {
  isSealedToken,
  type AnyToken,
  type TokenCatalog,
  type TokenValue,
} from '@openora/core/contracts';

export type Factory<T, C extends TokenCatalog> = (c: Container<C>) => T;

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

  registerSealedUnsafe<T>(token: AnyToken<T>, factory: Factory<T, C>): void {
    this.registerUnsafe(token, factory);
    this.sealed.add(token);
  }

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
