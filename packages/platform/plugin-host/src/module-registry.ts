import type { Type, DynamicModule } from '@nestjs/common';
import type { ModuleRegistry, McpToolDefinition } from './define-plugin.js';

export class ModuleRegistryImpl implements ModuleRegistry {
  private _providers: unknown[] = [];
  private _controllers: Type[] = [];
  private _routers = new Map<string, unknown>();
  private _slots = new Map<string, unknown>();
  private _events = new Map<string, Array<(payload: unknown) => void | Promise<void>>>();
  private _mcpTools: McpToolDefinition[] = [];
  private _imports: Array<Type | DynamicModule> = [];

  providers = {
    add: (provider: unknown) => {
      this._providers.push(provider);
    },
    getAll: () => this._providers,
  };

  controllers = {
    add: (controller: Type) => {
      this._controllers.push(controller);
    },
    getAll: () => this._controllers,
  };

  routers = {
    add: (namespace: string, router: unknown) => {
      this._routers.set(namespace, router);
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
    on: (event: string, handler: (payload: unknown) => void | Promise<void>) => {
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

  imports = {
    add: (module: Type | DynamicModule) => {
      this._imports.push(module);
    },
    getAll: () => this._imports,
  };
}
