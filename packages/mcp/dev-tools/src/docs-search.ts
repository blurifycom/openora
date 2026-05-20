import type { McpTool, McpToolResult } from '@oss/domain-schemas';

export const docsSearchTool: McpTool & { handler: (input: unknown) => Promise<McpToolResult> } = {
  name: 'docs_search',
  description: 'Search project documentation',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
    },
    required: ['query'],
  },
  handler: async (_input: unknown): Promise<McpToolResult> => ({
    content: [{ type: 'text', text: 'Docs search: stub' }],
  }),
};
