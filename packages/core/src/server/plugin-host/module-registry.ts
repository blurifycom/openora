import type { Container } from '../kernel/index.js';
import type {
  ActionTypeContract,
  McpToolContract,
  SealedToken,
  Token,
  TokenCatalog,
  TokenValue,
  WorkerRegistration,
} from '@openora/core/contracts';
import type {
  ActionTypeFactory,
  ModuleRegistry,
  McpToolDefinition,
  McpToolFactory,
  RegisteredActionType,
  RegisteredMcpTool,
  RouterFactory,
  TypedContainer,
  EventHandler,
} from './define-plugin.js';
import { assertValidActionType, assertValidMcpTool } from '../mcp/contract-validation.js';

const UNKNOWN_OWNER = 'unknown';

export class ModuleRegistryImpl<C extends TokenCatalog> implements ModuleRegistry<C> {
  private _routers = new Map<string, RouterFactory<C>>();
  private _events = new Map<string, EventHandler[]>();
  private _jobs: WorkerRegistration<unknown>[] = [];
  private _mcpTools: McpToolDefinition[] = [];
  private _tools: RegisteredMcpTool<C>[] = [];
  private _actions: RegisteredActionType<C>[] = [];
  private _sealedBound = new Set<symbol>();
  private _owner = UNKNOWN_OWNER;

  constructor(private readonly container: Container<C>) {}

  setOwner(pluginId: string | null): void {
    this._owner = pluginId ?? UNKNOWN_OWNER;
  }

  // Last-wins, so an overlay loaded after a module can rebind its adapter token.
  // Sealed tokens (Symbol description prefixed `sealed:`) are rejected at runtime
  // even though the type system already blocks them - catches plain-JS callers and cast escapes.
  // Canonical sealed list lives in `@openora/core/compliance`.
  provide = <T extends Token<unknown>>(
    token: T,
    factory: (container: TypedContainer<C>) => TokenValue<T>,
  ): void => {
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
    this.container.registerUnsafe(token, factory);
  };

  // Bind-once. The owning module calls this during its own register() to bind the
  // canonical implementation; a second call for the same token - an overlay trying
  // to slip past provide()'s rejection, or a duplicate registration - throws instead
  // of silently rebinding (there is no "last-wins" for a sealed token).
  provideSealed = <T extends SealedToken<unknown>>(
    token: T,
    factory: (container: TypedContainer<C>) => TokenValue<T>,
  ): void => {
    if (this._sealedBound.has(token)) {
      throw new Error(
        `[plugin-host] Sealed token (${token.description ?? '(unnamed)'}) is already bound. ` +
          `A sealed service may be bound exactly once, by its owning module, and never rebound.`,
      );
    }
    this._sealedBound.add(token);
    this.container.registerUnsafe(token, factory);
  };

  routers = {
    add: (namespace: string, factory: RouterFactory<C>) => {
      if (this._routers.has(namespace)) {
        throw new Error(`Router namespace "${namespace}" is already registered`);
      }
      this._routers.set(namespace, factory);
    },
    getAll: () => this._routers,
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

  mcp: ModuleRegistry<C>['mcp'] = {
    tool: (...args: [McpToolDefinition] | [McpToolContract, McpToolFactory<C>]) => {
      if (args.length === 1) {
        this._mcpTools.push(args[0]);
        return;
      }
      const [contract, factory] = args;
      const registration = { contract, owner: this._owner, factory };
      assertValidMcpTool(registration, this.registrations());
      this._tools.push(registration);
    },
    getAll: () => this._mcpTools,
    getTools: () => this._tools,
  };

  actions: ModuleRegistry<C>['actions'] = {
    register: (contract: ActionTypeContract, factory: ActionTypeFactory<C>) => {
      const registration = { contract, owner: this._owner, factory };
      assertValidActionType(registration, this.registrations());
      this._actions.push(registration);
    },
    getAll: () => this._actions,
  };

  private registrations() {
    return { tools: this._tools, actions: this._actions };
  }
}
