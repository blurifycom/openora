import type { Container, Factory } from '../kernel/index.js';
import type { SealedToken, Token, TokenCatalog, WorkerRegistration } from '@openora/core/contracts';
import type {
  ModuleRegistry,
  McpToolDefinition,
  RouterFactory,
  EventHandler,
} from './define-plugin.js';

export class ModuleRegistryImpl<C extends TokenCatalog = never> implements ModuleRegistry<C> {
  private _routers = new Map<string, RouterFactory>();
  private _slots = new Map<string, unknown>();
  private _events = new Map<string, EventHandler[]>();
  private _jobs: WorkerRegistration<unknown>[] = [];
  private _mcpTools: McpToolDefinition[] = [];
  private _sealedBound = new Set<symbol>();

  constructor(private readonly container: Container<C>) {}

  // Last-wins, so an overlay loaded after a module can rebind its adapter token.
  // Sealed tokens (Symbol description prefixed `sealed:`) are rejected at runtime
  // even though the type system already blocks them - catches plain-JS callers and cast escapes.
  // Canonical sealed list lives in `@openora/core/compliance`.
  provide = <T>(token: Token<T>, factory: Factory<T>): void => {
    const desc = token.description ?? '';
    if (desc.startsWith('sealed:')) {
      throw new Error(
        `[plugin-host] Refusing to bind a sealed token (${desc}). ` +
          `Sealed services back regulatory invariants (RG enforcement, KYC writes, ` +
          `AML/SAR, ledger writes, RNG, etc.) and may not be replaced by a plugin. ` +
          `Its owning module binds it via ctx.provideSealed() instead. ` +
          `See @openora/core/compliance for the canonical list.`,
      );
    }
    this.container.register(token, factory);
  };

  // Bind-once. The owning module calls this during its own register() to bind the
  // canonical implementation; a second call for the same token - an overlay trying
  // to slip past provide()'s rejection, or a duplicate registration - throws instead
  // of silently rebinding (there is no "last-wins" for a sealed token).
  provideSealed = <T>(token: SealedToken<T>, factory: Factory<T>): void => {
    if (this._sealedBound.has(token)) {
      throw new Error(
        `[plugin-host] Sealed token (${token.description ?? '(unnamed)'}) is already bound. ` +
          `A sealed service may be bound exactly once, by its owning module, and never rebound.`,
      );
    }
    this._sealedBound.add(token);
    this.container.register(token, factory);
  };

  routers = {
    add: (namespace: string, factory: RouterFactory) => {
      if (this._routers.has(namespace)) {
        throw new Error(`Router namespace "${namespace}" is already registered`);
      }
      this._routers.set(namespace, factory);
    },
    getAll: () => this._routers,
  };

  slots = {
    fill: (slotName: string, component: unknown) => {
      this._slots.set(slotName, component);
    },
    getAll: () => this._slots,
  };

  events = {
    on: (event: string, handler: EventHandler) => {
      const handlers = this._events.get(event) ?? [];
      handlers.push(handler);
      this._events.set(event, handlers);
    },
    getAll: () => this._events,
  };

  jobs = {
    worker: <T>(registration: WorkerRegistration<T>) => {
      this._jobs.push(registration as WorkerRegistration<unknown>);
    },
    getAll: () => this._jobs,
  };

  mcp = {
    tool: (definition: McpToolDefinition) => {
      this._mcpTools.push(definition);
    },
    getAll: () => this._mcpTools,
  };
}
