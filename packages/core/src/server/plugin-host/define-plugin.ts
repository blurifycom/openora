import type {
  EventEnvelope,
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

// Runs once at boot, after every plugin has registered its providers, so adapter overrides (last registration wins) are in effect.
export type RouterFactory<C extends TokenCatalog> = (c: TypedContainer<C>) => unknown;

export type TypedContainer<C extends TokenCatalog> = {
  get<T extends C[keyof C]>(token: T): TokenValue<T>;
  has<T extends C[keyof C]>(token: T): boolean;
  onDispose(fn: () => void | Promise<void>): void;
};

export type EventHandler = (payload: unknown, envelope?: EventEnvelope) => void | Promise<void>;

export type ModuleRegistry<C extends TokenCatalog> = {
  // Last registration wins - an overlay loaded after a module can rebind its adapter token.
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
  slots: {
    fill(slotName: string, component: unknown): void;
    getAll(): Map<string, unknown>;
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
    tool(definition: McpToolDefinition): void;
    getAll(): McpToolDefinition[];
  };
};

export type PluginContext<C extends TokenCatalog> = ModuleRegistry<C>;

export type PluginDefinition<
  C extends TokenCatalog,
  Id extends string = string,
  Dependencies extends readonly string[] = string[],
> = {
  id: Id;
  dependsOn?: Dependencies;
  // Verified once after all plugins register - a missing port fails fast. See ADR-0024.
  requiresPorts?: Array<C[keyof C] & Token<unknown>>;
  register: (ctx: PluginContext<C>) => void | Promise<void>;
};

export type Plugin<
  C extends TokenCatalog,
  Id extends string = string,
  Dependencies extends readonly string[] = string[],
> = PluginDefinition<C, Id, Dependencies>;

export function definePluginWithCatalog<C extends TokenCatalog>() {
  return function defineCataloguedPlugin<
    const Id extends string,
    const Dependencies extends readonly string[] = [],
  >(definition: PluginDefinition<C, Id, Dependencies>): Plugin<C, Id, Dependencies> {
    return definition;
  };
}
