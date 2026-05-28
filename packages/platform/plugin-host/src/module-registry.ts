import type { Container, Factory } from '@oss/core';
import type { Token } from '@oss/adapters';
import type {
  ModuleRegistry,
  McpToolDefinition,
  RouterFactory,
  EventHandler,
} from './define-plugin.js';

export class ModuleRegistryImpl implements ModuleRegistry {
  private _routers = new Map<string, RouterFactory>();
  private _slots = new Map<string, unknown>();
  private _events = new Map<string, EventHandler[]>();
  private _mcpTools: McpToolDefinition[] = [];

  constructor(private readonly container: Container) {}

  // Provider bindings go straight into the container. Lazy + last-wins, so an
  // overlay loaded after a module can rebind that module's adapter token.
  //
  // Runtime guard: tokens created via `createSealedToken` carry a `sealed:`
  // prefix in their Symbol description. We reject those at registration time
  // even though `SealedToken<T>` is structurally incompatible with `Token<T>`
  // at the type level - this catches plain-JS callers and any cast escape.
  // The canonical sealed list (with regulatory citations per token) lives in
  // `@oss/compliance-invariants`.
  provide = <T>(token: Token<T>, factory: Factory<T>): void => {
    const desc = token.description ?? '';
    if (desc.startsWith('sealed:')) {
      throw new Error(
        `[plugin-host] Refusing to bind a sealed token (${desc}). ` +
          `Sealed services back regulatory invariants (RG enforcement, KYC writes, ` +
          `AML/SAR, ledger writes, RNG, etc.) and may not be replaced by a plugin. ` +
          `See @oss/compliance-invariants for the canonical list.`,
      );
    }
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

  mcp = {
    tool: (definition: McpToolDefinition) => {
      this._mcpTools.push(definition);
    },
    getAll: () => this._mcpTools,
  };
}
