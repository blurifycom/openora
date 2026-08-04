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
export type RouterFactory<C extends TokenCatalog = never> = (c: ContainerView<C>) => unknown;

export type TypedContainer<C extends TokenCatalog> = {
  get<T extends C[keyof C]>(token: T): TokenValue<T>;
  has<T extends C[keyof C]>(token: T): boolean;
  onDispose(fn: () => void | Promise<void>): void;
};

export type EventHandler = (payload: unknown, envelope?: EventEnvelope) => void | Promise<void>;

// The container view a factory receives: the full Container when uncatalogued, or
// a view restricted to the catalog's own tokens otherwise.
export type ContainerView<C extends TokenCatalog> = [C] extends [never]
  ? Container
  : TypedContainer<C>;

// The token shape provide()/provideSealed() accept: any Token/SealedToken when
// uncatalogued, or a catalog-listed one when C is a real catalog. T is inferred
// directly from the token argument (never a keyof reverse lookup) - that's what
// makes TokenValue<T> resolve to that one entry instead of a union of every
// catalog value.
type ProviderToken<C extends TokenCatalog> = [C] extends [never]
  ? Token<unknown>
  : C[keyof C] & Token<unknown>;

type SealedProviderToken<C extends TokenCatalog> = [C] extends [never]
  ? SealedToken<unknown>
  : C[keyof C] & SealedToken<unknown>;

export type ModuleRegistry<C extends TokenCatalog = never> = {
  // Last registration wins - an overlay loaded after a module can rebind its adapter token.
  provide<T extends ProviderToken<C>>(
    token: T,
    factory: (container: ContainerView<C>) => TokenValue<T>,
  ): void;
  // Bind-once, owner-only. The ONLY legitimate way to bind a SealedToken - provide()
  // rejects sealed tokens outright. A second call for the same token (an overlay
  // trying to override a regulator-mandated service) throws instead of rebinding.
  provideSealed<T extends SealedProviderToken<C>>(
    token: T,
    factory: (container: ContainerView<C>) => TokenValue<T>,
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
  requiresPorts?: ProviderToken<C>[];
  register(ctx: PluginContext<C>): void | Promise<void>;
};

export type Plugin<
  C extends TokenCatalog = never,
  Id extends string = string,
  Dependencies extends readonly string[] = string[],
> = PluginDefinition<C, Id, Dependencies>;

// `requiresPorts` is widened to a plain Token[] here only: TS can't prove the
// deferred `ProviderToken<C>` conditional (unresolved for a generic C) is
// assignable against the never-catalog overload's resolved branch, even though
// every real instantiation of C does resolve safely - a checker limitation on
// this one field, not a hole in the constraint itself.
type LooseDefinition<C extends TokenCatalog> = Omit<PluginDefinition<C>, 'requiresPorts'> & {
  requiresPorts?: Token<unknown>[];
};

// Uncatalogued: definePlugin({ id, register }) - the plugin host's original,
// single-call form. Unchanged for consumer overlays and scaffolded modules that
// don't need catalog-constrained container access.
export function definePlugin<
  const Id extends string = string,
  const Dependencies extends readonly string[] = [],
>(definition: PluginDefinition<never, Id, Dependencies>): Plugin<never, Id, Dependencies>;
// Catalogued: definePlugin<CoreTokenCatalog>()({ id, register }). C is fixed by the
// first (argument-less) call so the second call's Id/Dependencies still infer from
// the literal object - TypeScript won't infer a trailing `const` type parameter
// past one supplied explicitly in the same call.
export function definePlugin<C extends TokenCatalog>(): <
  const Id extends string,
  const Dependencies extends readonly string[] = [],
>(
  definition: PluginDefinition<C, Id, Dependencies>,
) => Plugin<C, Id, Dependencies>;
export function definePlugin<C extends TokenCatalog = never>(
  definition?: LooseDefinition<C>,
): LooseDefinition<C> | ((definition: LooseDefinition<C>) => LooseDefinition<C>) {
  if (definition === undefined) {
    return (inner: LooseDefinition<C>) => inner;
  }
  return definition;
}
