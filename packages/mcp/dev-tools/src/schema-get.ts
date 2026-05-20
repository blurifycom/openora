import type { McpTool } from '@oss/domain-schemas';
import type { McpToolResult } from '@oss/domain-schemas';

export const schemaGetTool: McpTool & { handler: (input: unknown) => Promise<McpToolResult> } = {
  name: 'schema_get',
  description: 'Get a domain schema by name',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Schema name' },
    },
    required: ['name'],
  },
  handler: async (_input: unknown): Promise<McpToolResult> => ({
    content: [{ type: 'text', text: 'Schema: stub' }],
  }),
};
