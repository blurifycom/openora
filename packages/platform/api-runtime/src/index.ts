export { createApp } from './create-app.js';
export type { CreateAppConfig, CreatedApp } from './create-app.js';
export { AppModule } from './app.module.js';
export type { AppModuleOptions } from './app.module.js';
export { InfraModule } from './infra.module.js';
export { HealthController, HealthModule } from './health.controller.js';

export { seedDemoData } from './seed.js';
export type { SeedAuth, SeedOptions, SeedResult } from './seed.js';

// Re-export plugin-host primitives so consumers only need one import.
export { definePlugin, type Plugin, type PluginEntry, type ModuleRegistry } from '@oss/plugin-host';
