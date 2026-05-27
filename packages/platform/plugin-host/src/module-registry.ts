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
  provide = <T>(token: Token<T>, factory: Factory<T>): void => {
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
