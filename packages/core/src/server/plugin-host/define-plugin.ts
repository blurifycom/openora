import type { Container } from '../kernel/index.js';
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
export type RouterFactory<C extends TokenCatalog = never> = (
  c: [C] extends [never] ? Container : TypedContainer<C>,
) => unknown;

export type TypedContainer<C extends TokenCatalog> = {
  get<K extends keyof C>(token: C[K]): TokenValue<C[K]>;
  has<K extends keyof C>(token: C[K]): boolean;
  onDispose(fn: () => void | Promise<void>): void;
};

export type EventHandler = (payload: unknown, envelope?: EventEnvelope) => void | Promise<void>;

type CatalogToken<C extends TokenCatalog, T> = [C] extends [never]
  ? Token<T>
  : C[keyof C] & Token<T>;

type PluginContainer<C extends TokenCatalog> = Container<C>;

type CatalogTokenValue<C extends TokenCatalog, K extends keyof C> = TokenValue<C[K]>;

export type ModuleRegistry<C extends TokenCatalog = never> = {
  // Last registration wins - an overlay loaded after a module can rebind its adapter token.
  provide<K extends keyof C>(
    token: C[K] & Token<CatalogTokenValue<C, K>>,
    factory: (container: TypedContainer<C>) => CatalogTokenValue<C, K>,
  ): void;
  provide<T>(
    token: [C] extends [never] ? Token<T> : never,
    factory: (container: PluginContainer<C>) => T,
  ): void;
  // Bind-once, owner-only. The ONLY legitimate way to bind a SealedToken - provide()
  // rejects sealed tokens outright. A second call for the same token (an overlay
  // trying to override a regulator-mandated service) throws instead of rebinding.
  provideSealed<K extends keyof C>(
    token: C[K] & SealedToken<CatalogTokenValue<C, K>>,
    factory: (container: TypedContainer<C>) => CatalogTokenValue<C, K>,
  ): void;
  provideSealed<T>(
    token: [C] extends [never] ? SealedToken<T> : never,
    factory: (container: PluginContainer<C>) => T,
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

export type PluginContext<C extends TokenCatalog = never> = ModuleRegistry<C>;

export type PluginDefinition<
  C extends TokenCatalog = never,
  Id extends string = string,
  Dependencies extends readonly string[] = string[],
> = {
  id: Id;
  dependsOn?: Dependencies;
  // Verified once after all plugins register - a missing port fails fast. See ADR-0024.
  requiresPorts?: CatalogToken<C, unknown>[];
  register: (ctx: PluginContext<C>) => void | Promise<void>;
};

export type Plugin<
  C extends TokenCatalog = never,
  Id extends string = string,
  Dependencies extends readonly string[] = string[],
> = PluginDefinition<C, Id, Dependencies>;

export function definePlugin<
  C extends TokenCatalog = never,
  const Id extends string = string,
  const Dependencies extends readonly string[] = [],
>(definition: PluginDefinition<C, Id, Dependencies>): Plugin<C, Id, Dependencies> {
  return definition;
}

export function definePluginWithCatalog<C extends TokenCatalog>() {
  return function defineCataloguedPlugin<
    const Id extends string,
    const Dependencies extends readonly string[] = [],
  >(definition: PluginDefinition<C, Id, Dependencies>): Plugin<C, Id, Dependencies> {
    return definition;
  };
}
