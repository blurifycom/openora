export { createApp } from './create-app.js';
export type { CreateAppConfig, CreatedApp } from './create-app.js';

export { generateOpenApiSpec } from './openapi.js';
export type { GenerateOpenApiSpecOptions } from './openapi.js';

// Tenant lookup helper - the consumer wraps it with its PAM `user` table to build
// createApp's `resolveTenant` (the engine owns no domain schema). See ADR-0025.
export { resolveTenantForUser } from './tenant-resolver.js';

// Re-export plugin-host + composition primitives so consumers only need one import.
export {
  definePlugin,
  type Plugin,
  type PluginEntry,
  type ModuleRegistry,
} from '../plugin-host/index.js';
export { Container } from '../kernel/index.js';
