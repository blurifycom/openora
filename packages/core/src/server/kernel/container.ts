import type { Token } from '@blurifycom/core/contracts';

// Functional DI container. Resolution is lazy and cached; last `register` for a
// token wins - overlays rebind adapters by registering after the default binding.

export type Factory<T> = (c: Container) => T;

export class Container {
  private readonly factories = new Map<symbol, Factory<unknown>>();
  private readonly instances = new Map<symbol, unknown>();
  private readonly resolving = new Set<symbol>();
  private readonly disposers: Array<() => void | Promise<void>> = [];

  register<T>(token: Token<T>, factory: Factory<T>): void {
    this.factories.set(token, factory as Factory<unknown>);
    this.instances.delete(token);
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

  onDispose(fn: () => void | Promise<void>): void {
    this.disposers.push(fn);
  }

  async dispose(): Promise<void> {
    for (const fn of [...this.disposers].reverse()) {
      await fn();
    }
  }
}
