import type { McpTool } from '@oss/domain-schemas';
import { schemaGetTool } from './schema-get.js';
import { docsSearchTool } from './docs-search.js';
import { dbQueryReadonlyTool } from './db-query-readonly.js';

export { schemaGetTool } from './schema-get.js';
export { docsSearchTool } from './docs-search.js';
export { dbQueryReadonlyTool } from './db-query-readonly.js';

export const devTools: McpTool[] = [schemaGetTool, docsSearchTool, dbQueryReadonlyTool];
