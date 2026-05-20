import { DynamicModule, Global, Module, Provider, Type } from '@nestjs/common';
import { RouterRegistry } from './router-registry.js';
import { loadPlugins, type PluginEntry } from './load-plugins.js';
import { LOADED_REGISTRY } from './tokens.js';

export interface PluginHostModuleOptions {
  extensions: PluginEntry[];
}

@Global()
@Module({})
export class PluginHostModule {
  static async forRoot(options: PluginHostModuleOptions): Promise<DynamicModule> {
    const registry = await loadPlugins(options.extensions);

    const extraProviders = registry.providers.getAll() as Provider[];
    const extraControllers = registry.controllers.getAll() as Type[];
    const extraImports = registry.imports.getAll() as Array<Type | DynamicModule>;

    return {
      module: PluginHostModule,
      global: true,
      imports: [...extraImports],
      controllers: [...extraControllers],
      providers: [
        RouterRegistry,
        {
          provide: LOADED_REGISTRY,
          useValue: registry,
        },
        ...extraProviders,
      ],
      exports: [RouterRegistry, LOADED_REGISTRY, ...extraProviders],
    };
  }
}
