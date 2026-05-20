import type { McpTool, McpToolResult } from '@oss/domain-schemas';

export const dbQueryReadonlyTool: McpTool & {
  handler: (input: unknown) => Promise<McpToolResult>;
} = {
  name: 'db_query_readonly',
  description: 'Execute a read-only SQL query against the dev database',
  inputSchema: {
    type: 'object',
    properties: {
      sql: { type: 'string', description: 'Read-only SQL query' },
    },
    required: ['sql'],
  },
  handler: async (_input: unknown): Promise<McpToolResult> => ({
    content: [{ type: 'text', text: 'DB query: stub' }],
  }),
};
