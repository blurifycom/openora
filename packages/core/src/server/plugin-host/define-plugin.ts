import type { Container, Factory } from '../kernel/index.js';
import type { Token, WorkerRegistration } from '@blurifycom/core/contracts';

export type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
};

// Runs once at boot, after every plugin has registered its providers, so adapter overrides (last registration wins) are in effect.
export type RouterFactory = (c: Container) => unknown;

export type EventHandler = (payload: unknown) => void | Promise<void>;

export type ModuleRegistry = {
  // Last registration wins - an overlay loaded after a module can rebind its adapter token.
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

export type Plugin = {
  id: string;
  dependsOn?: string[];
  // Verified once after all plugins register - a missing port fails fast. See ADR-0024.
  requiresPorts?: Token<unknown>[];
  register: (ctx: ModuleRegistry) => void | Promise<void>;
};

export type PluginDefinition = {
  id: string;
  dependsOn?: string[];
  requiresPorts?: Token<unknown>[];
  register: (ctx: ModuleRegistry) => void | Promise<void>;
};

export function definePlugin(definition: PluginDefinition): Plugin {
  return definition;
}
