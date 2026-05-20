import { DynamicModule, Module, Provider, Type, type ModuleMetadata } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { ORPCModule, onError, ORPCError } from '@orpc/nest';
import { experimental_RethrowHandlerPlugin as RethrowHandlerPlugin } from '@orpc/server/plugins';
import type { Request, Response } from 'express';
import { PluginHostModule, type PluginEntry } from '@oss/plugin-host';
import { InfraModule } from './infra.module.js';
import { HealthModule } from './health.controller.js';

declare module '@orpc/nest' {
  interface ORPCGlobalContext {
    request: Request;
    response: Response;
  }
}

export interface AppModuleOptions {
  plugins: PluginEntry[];
  // Extra Nest modules to import alongside the OSS defaults.
  extraImports?: Array<Type | DynamicModule>;
  // Extra providers (DI tokens, factories) to register globally.
  extraProviders?: Provider[];
  // Skip the built-in HealthModule (rarely needed).
  disableHealthModule?: boolean;
}

@Module({})
export class AppModule {
  static async create(options: AppModuleOptions): Promise<DynamicModule> {
    const pluginHostModule = await PluginHostModule.forRoot({
      extensions: options.plugins,
    });

    const imports: ModuleMetadata['imports'] = [
      InfraModule,
      ...(options.disableHealthModule ? [] : [HealthModule]),
      pluginHostModule,
      ORPCModule.forRootAsync({
        useFactory: (request: Request) => ({
          context: { request, response: request.res as Response },
          interceptors: [
            onError((error) => {
              if (!(error instanceof ORPCError)) {
                console.error('[oRPC unhandled]', error);
              }
            }),
          ],
          plugins: [
            new RethrowHandlerPlugin({
              filter: (error) => !(error instanceof ORPCError),
            }),
          ],
        }),
        inject: [REQUEST],
      }),
      ...(options.extraImports ?? []),
    ];

    return {
      module: AppModule,
      imports,
      ...(options.extraProviders ? { providers: options.extraProviders } : {}),
    };
  }
}
