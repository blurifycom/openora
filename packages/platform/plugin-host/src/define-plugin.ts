import type { Container, Factory } from '@oss/core';
import type { Token } from '@oss/adapters';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
}

// A router factory builds the module's oRPC router from the resolved container
// (services + adapters). It runs once at boot, after every plugin has registered
// its providers, so adapter overrides (last registration wins) are in effect.
export type RouterFactory = (c: Container) => unknown;

export type EventHandler = (payload: unknown) => void | Promise<void>;

export interface ModuleRegistry {
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
  mcp: {
    tool(definition: McpToolDefinition): void;
    getAll(): McpToolDefinition[];
  };
}

export interface Plugin {
  id: string;
  dependsOn?: string[];
  register: (ctx: ModuleRegistry) => void | Promise<void>;
}

export interface PluginDefinition {
  id: string;
  dependsOn?: string[];
  register: (ctx: ModuleRegistry) => void | Promise<void>;
}

export function definePlugin(definition: PluginDefinition): Plugin {
  return definition;
}
