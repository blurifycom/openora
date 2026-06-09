export { createApp } from './create-app.js';
export type { CreateAppConfig, CreatedApp } from './create-app.js';

export { seedDemoData, DEMO_TENANT_ID } from './seed.js';
export type { SeedAuth, SeedOptions, SeedResult } from './seed.js';

// Re-export plugin-host + composition primitives so consumers only need one import.
export { definePlugin, type Plugin, type PluginEntry, type ModuleRegistry } from '@oss/plugin-host';
export { Container } from '@oss/core';
