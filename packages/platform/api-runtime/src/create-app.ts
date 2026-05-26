import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, DynamicModule, Provider, Type } from '@nestjs/common';
import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import type { ContractRouter } from '@orpc/contract';
import type { PluginEntry } from '@oss/plugin-host';
import { contract as defaultContract } from '@oss/orpc-contract';
import { CASINO_CONFIG, type CasinoConfig } from '@oss/shared-schemas';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { AppModule } from './app.module.js';

export interface CreateAppConfig {
  // Plugins to load. Each module/extension exposes a definePlugin() entry.
  plugins: PluginEntry[];

  // Port to listen on. Defaults to env PORT_API, then 3001.
  port?: number;

  // CORS configuration. `true` enables permissive defaults, `false` disables,
  // or pass an explicit origins list. Defaults to `true`.
  cors?: boolean | { origins?: string | string[] | RegExp | RegExp[] };

  // Override DATABASE_URL at runtime (otherwise read from env).
  databaseUrl?: string;

  // Override the oRPC root contract used for OpenAPI emit.
  // Consumers can compose the OSS contract with their own extensions.
  contract?: ContractRouter<any>;

  // OpenAPI spec emission settings.
  openapi?: {
    enabled?: boolean; // default true
    info?: { title?: string; version?: string };
    outputPath?: string; // absolute path, default docs/openapi.json next to cwd
  };

  // Declarative casino configuration (currencies, jurisdictions, limits, provider
  // selection, branding). Build it with defineCasinoConfig() from @oss/shared-schemas.
  // Injected app-wide via the CASINO_CONFIG token.
  casino?: CasinoConfig;

  // Extra Nest modules/providers to wire in (advanced).
  extraImports?: Array<Type | DynamicModule>;
  extraProviders?: Provider[];

  // Skip the built-in HealthController (rarely needed - default false).
  disableHealthModule?: boolean;
}

export interface CreatedApp {
  app: INestApplication;
  port: number;
  listen(): Promise<void>;
  emitOpenApiSpec(): Promise<string | null>;
  close(): Promise<void>;
}

export async function createApp(config: CreateAppConfig): Promise<CreatedApp> {
  if (config.databaseUrl) {
    process.env['DATABASE_URL'] = config.databaseUrl;
  }

  const casinoProvider: Provider[] = config.casino
    ? [{ provide: CASINO_CONFIG, useValue: config.casino }]
    : [];
  const extraProviders = [...casinoProvider, ...(config.extraProviders ?? [])];

  const appModule = await AppModule.create({
    plugins: config.plugins,
    ...(config.extraImports ? { extraImports: config.extraImports } : {}),
    ...(extraProviders.length > 0 ? { extraProviders } : {}),
    ...(config.disableHealthModule !== undefined
      ? { disableHealthModule: config.disableHealthModule }
      : {}),
  });

  const app = await NestFactory.create(appModule);

  if (config.cors !== false) {
    if (config.cors === true || config.cors === undefined) {
      app.enableCors({ credentials: true });
    } else {
      app.enableCors({ origin: config.cors.origins, credentials: true });
    }
  }

  const port = config.port ?? Number(process.env['PORT_API'] ?? 3001);

  return {
    app,
    port,
    async listen() {
      await app.listen(port);
      process.stdout.write(`API listening on :${port}\n`);
    },
    async emitOpenApiSpec() {
      if (config.openapi?.enabled === false) return null;
      const contract = config.contract ?? defaultContract;
      const generator = new OpenAPIGenerator({
        schemaConverters: [new ZodToJsonSchemaConverter()],
      });
      const spec = await generator.generate(contract, {
        info: {
          title: config.openapi?.info?.title ?? 'OSS Casino API',
          version: config.openapi?.info?.version ?? '0.0.1',
        },
      });
      const outPath = config.openapi?.outputPath ?? resolve(process.cwd(), 'docs/openapi.json');
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
      process.stdout.write(`OpenAPI spec written to ${outPath}\n`);
      return outPath;
    },
    async close() {
      await app.close();
    },
  };
}
