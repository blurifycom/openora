import type { Token } from '@oss/adapters';

// Functional composition container - the explicit replacement for Nest DI.
// No decorators, no reflection: a provider is just a factory that names its own
// dependencies by resolving them from the container. Resolution is lazy and
// cached; the last `register` for a token wins (so an overlay can rebind an
// adapter by registering after the module that owns the default binding).

export type Factory<T> = (c: Container) => T;

export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving = new Set<symbol>();
  private readonly disposers: Array<() => void | Promise<void>> = [];

  register<T>(token: Token<T>, factory: Factory<T>): void {
    this.factories.set(token, factory as Factory<unknown>);
    this.instances.delete(token); // drop any cached instance from a prior binding
  }

  has(token: Token<unknown>): boolean {
    return this.factories.has(token);
  }

  get<T>(token: Token<T>): T {
    if (this.instances.has(token)) return this.instances.get(token) as T;

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

  // Register teardown (eg closing a DB pool). Run in reverse order on dispose().
  onDispose(fn: () => void | Promise<void>): void {
    this.disposers.push(fn);
  }

  async dispose(): Promise<void> {
    for (const fn of [...this.disposers].reverse()) {
      await fn();
    }
  }
}
