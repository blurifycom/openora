import type { Container, Factory } from '@oss/core';
import type { Token, WorkerRegistration } from '@oss/adapters';

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
};

// A router factory builds the module's oRPC router from the resolved container
// (services + adapters). It runs once at boot, after every plugin has registered
// its providers, so adapter overrides (last registration wins) are in effect.
export type RouterFactory = (c: Container) => unknown;

export type EventHandler = (payload: unknown) => void | Promise<void>;

export type ModuleRegistry = {
  // Bind a provider factory to a token. Last registration wins, so an overlay
  // loaded after a module can rebind that module's adapter token.
  provide<T>(token: Token<T>, factory: Factory<T>): void;
  routers: {
    add(namespace: string, factory: RouterFactory): void;
    getAll(): Map<string, RouterFactory>;
  };
  slots: {
    fill(slotName: string, component: unknown): void;
    getAll(): Map<string, unknown>;
  };
  events: {
    on(event: string, handler: EventHandler): void;
    getAll(): Map<string, EventHandler[]>;
  };
  // Register a background-job worker. Collected during register() and started at
  // boot against the resolved JOB_QUEUE (after all providers, so an overlay's
  // durable driver is in effect). Mirrors the events collector. See ADR-0014.
  jobs: {
    worker<T>(registration: WorkerRegistration<T>): void;
    getAll(): WorkerRegistration<unknown>[];
  };
  mcp: {
    tool(definition: McpToolDefinition): void;
    getAll(): McpToolDefinition[];
  };
};

export type Plugin = {
  id: string;
  dependsOn?: string[];
  register: (ctx: ModuleRegistry) => void | Promise<void>;
};

export type PluginDefinition = {
  id: string;
  dependsOn?: string[];
  register: (ctx: ModuleRegistry) => void | Promise<void>;
};

export function definePlugin(definition: PluginDefinition): Plugin {
  return definition;
}
