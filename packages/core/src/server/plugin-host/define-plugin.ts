import type * as z from 'zod';
import type {
  ActionTypeContract,
  ActionTypeImplementation,
  EventEnvelope,
  McpToolContract,
  McpToolHandler,
  SealedToken,
  Token,
  TokenCatalog,
  TokenValue,
  WorkerRegistration,
} from '@openora/core/contracts';

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
};

/**
 * Container view a plugin's `provide()`/`provideSealed()` factory and router
 * factories receive: read-only (`get`/`has`/`onDispose`) and catalog-constrained
 * - never the full `Container`, so plugin code can't call `register()` directly
 * and bypass ModuleRegistry's sealed-token rejection.
 */
export type TypedContainer<C extends TokenCatalog> = {
  get<T extends C[keyof C]>(token: T): TokenValue<T>;
  has<T extends C[keyof C]>(token: T): boolean;
  onDispose(fn: () => void | Promise<void>): void;
};

// Runs once at boot, after every plugin has registered its providers, so adapter overrides (last registration wins) are in effect.
export type RouterFactory<C extends TokenCatalog> = (c: TypedContainer<C>) => unknown;

export type EventHandler = (payload: unknown, envelope?: EventEnvelope) => void | Promise<void>;

// Tool and action-type factories run once, when MCP_KERNEL is built after every provider is
// bound - never at registration.
export type McpToolFactory<
  C extends TokenCatalog,
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
> = (c: TypedContainer<C>) => McpToolHandler<I, O>;

export type ActionTypeFactory<C extends TokenCatalog, P extends z.ZodObject = z.ZodObject> = (
  c: TypedContainer<C>,
) => ActionTypeImplementation<P>;

export type RegisteredMcpTool<C extends TokenCatalog> = {
  contract: McpToolContract;
  owner: string;
  factory: McpToolFactory<C>;
};

export type RegisteredActionType<C extends TokenCatalog> = {
  contract: ActionTypeContract;
  owner: string;
  factory: ActionTypeFactory<C>;
};

export type ModuleRegistry<C extends TokenCatalog> = {
  // Last registration wins - an overlay loaded after a module can rebind its adapter token.
  // T is inferred directly from the token argument (never a keyof reverse lookup) -
  // that's what makes TokenValue<T> resolve to that one catalog entry instead of a
  // union of every catalog value.
  provide<T extends C[keyof C] & Token<unknown>>(
    token: T,
    factory: (container: TypedContainer<C>) => TokenValue<T>,
  ): void;
  // Bind-once, owner-only. The ONLY legitimate way to bind a SealedToken - provide()
  // rejects sealed tokens outright. A second call for the same token (an overlay
  // trying to override a regulator-mandated service) throws instead of rebinding.
  provideSealed<T extends C[keyof C] & SealedToken<unknown>>(
    token: T,
    factory: (container: TypedContainer<C>) => TokenValue<T>,
  ): void;
  routers: {
    add(namespace: string, factory: RouterFactory<C>): void;
    getAll(): Map<string, RouterFactory<C>>;
  };
  events: {
    on(event: string, handler: EventHandler): void;
    getAll(): Map<string, EventHandler[]>;
  };
  // Started at boot against the resolved JOB_QUEUE (after all providers, so an overlay's durable driver is in effect). See ADR-0014.
  jobs: {
    worker<T>(registration: WorkerRegistration<T>): void;
    getAll(): WorkerRegistration<unknown>[];
  };
  mcp: {
    /** Legacy untyped form: listed by `getAll()` only, never served by MCP_KERNEL. */
    tool(definition: McpToolDefinition): void;
    tool<I extends z.ZodObject, O extends z.ZodObject>(
      contract: McpToolContract<I, O>,
      factory: McpToolFactory<C, I, O>,
    ): void;
    getAll(): McpToolDefinition[];
    getTools(): readonly RegisteredMcpTool<C>[];
  };
  actions: {
    register<P extends z.ZodObject>(
      contract: ActionTypeContract<P>,
      factory: ActionTypeFactory<C, P>,
    ): void;
    getAll(): readonly RegisteredActionType<C>[];
  };
};

export type PluginContext<C extends TokenCatalog> = ModuleRegistry<C>;

export type Plugin<C extends TokenCatalog> = {
  id: string;
  dependsOn?: readonly string[];
  // Verified once after all plugins register - a missing port fails fast. See ADR-0024.
  requiresPorts?: readonly (C[keyof C] & Token<unknown>)[];
  register(ctx: PluginContext<C>): void | Promise<void>;
};
