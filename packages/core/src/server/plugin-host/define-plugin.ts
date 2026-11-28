import type * as z from 'zod';
import type {
  ActionTypeContract,
  ActionTypeImplementation,
  EventEnvelope,
  McpToolContract,
  McpToolHandler,
  SealedToken,
  SubscribeOptions,
  Token,
  TokenCatalog,
  TokenValue,
  TriggerDescriptor,
  WorkerRegistration,
} from '@openora/core/contracts';

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
};

export type TypedContainer<C extends TokenCatalog> = {
  get<T extends C[keyof C]>(token: T): TokenValue<T>;
  has<T extends C[keyof C]>(token: T): boolean;
  onDispose(fn: () => void | Promise<void>): void;
};

export type RouterFactory<C extends TokenCatalog> = (
  c: TypedContainer<C>,
  options?: { mounted: boolean },
) => unknown;

export type EventHandler = (payload: unknown, envelope?: EventEnvelope) => void | Promise<void>;

export type TriggerListener = (
  trigger: TriggerDescriptor,
  payload: unknown,
  envelope: EventEnvelope,
) => void | Promise<void>;

export type RegisteredTriggerListener = {
  owner: string;
  listener: TriggerListener;
};

export type EventSubscriptionOptions = Pick<SubscribeOptions, 'consumerGroup'>;
export type RegisteredEventHandler = {
  handler: EventHandler;
  consumer: string;
  consumerGroup?: string;
};

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
  provide<T extends C[keyof C] & Token<unknown>>(
    token: T,
    factory: (container: TypedContainer<C>) => TokenValue<T>,
  ): void;
  provideSealed<T extends C[keyof C] & SealedToken<unknown>>(
    token: T,
    factory: (container: TypedContainer<C>) => TokenValue<T>,
  ): void;
  routers: {
    add(namespace: string, factory: RouterFactory<C>): void;
    addInternal(namespace: string, factory: RouterFactory<C>): void;
    getAll(): Map<string, RouterFactory<C>>;
    getInternal(): Map<string, RouterFactory<C>>;
  };
  events: {
    on(event: string, handler: EventHandler, options?: EventSubscriptionOptions): void;
    getAll(): Map<string, RegisteredEventHandler[]>;
  };
  triggers: {
    listen(listener: TriggerListener): void;
    getAll(): readonly RegisteredTriggerListener[];
  };
  jobs: {
    worker<T>(registration: WorkerRegistration<T>): void;
    getAll(): WorkerRegistration<unknown>[];
  };
  mcp: {
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

export type OptionalPort<C extends TokenCatalog> = {
  port: C[keyof C];
  without: string;
};

export type ControlPort<C extends TokenCatalog> = OptionalPort<C> & {
  boundBy: string;
  routesOnly?: boolean;
};

export type Plugin<C extends TokenCatalog> = {
  id: string;
  dependsOn?: readonly string[];
  requiresPorts?: readonly C[keyof C][];
  optionalPorts?: readonly OptionalPort<C>[];
  controlPorts?: readonly ControlPort<C>[];
  register(ctx: PluginContext<C>): void | Promise<void>;
};
