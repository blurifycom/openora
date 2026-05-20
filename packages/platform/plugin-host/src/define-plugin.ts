import type { Type, DynamicModule } from '@nestjs/common';

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (input: unknown) => unknown | Promise<unknown>;
}

export interface ModuleRegistry {
  providers: {
    add(
      provider:
        | Type
        | {
            provide: unknown;
            useClass?: Type;
            useValue?: unknown;
            useFactory?: (...args: unknown[]) => unknown;
            inject?: unknown[];
          },
    ): void;
    getAll(): unknown[];
  };
  routers: {
    add(namespace: string, router: unknown): void;
    getAll(): Map<string, unknown>;
  };
  slots: {
    fill(slotName: string, component: unknown): void;
    getAll(): Map<string, unknown>;
  };
  events: {
    on(event: string, handler: (payload: unknown) => void | Promise<void>): void;
    getAll(): Map<string, Array<(payload: unknown) => void | Promise<void>>>;
  };
  prisma: {
    extend(modelName: string, fields: string): void;
    getExtensions(): Map<string, string[]>;
  };
  mcp: {
    tool(definition: McpToolDefinition): void;
    getAll(): McpToolDefinition[];
  };
  controllers: {
    add(controller: Type): void;
    getAll(): Type[];
  };
  imports: {
    add(module: Type | DynamicModule): void;
    getAll(): Array<Type | DynamicModule>;
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
