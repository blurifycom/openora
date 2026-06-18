export { createApp } from './create-app.js';
export type { CreateAppConfig, CreatedApp } from './create-app.js';

export { generateOpenApiSpec } from './openapi.js';
export type { GenerateOpenApiSpecOptions } from './openapi.js';

// Re-export plugin-host + composition primitives so consumers only need one import.
export {
  definePlugin,
  type Plugin,
  type PluginEntry,
  type ModuleRegistry,
} from '../plugin-host/index.js';
export { Container } from '../kernel/index.js';
