import type { McpTool } from '@oss/domain-schemas';

export type { McpTool };

export type McpServerOptions = {
  name: string;
  version: string;
  tools: McpTool[];
};

export class McpServer {
  constructor(private options: McpServerOptions) {}

  getTools(): McpTool[] {
    return this.options.tools;
  }

  // HTTP+SSE mounting will be done in apps/mcp-server-dev
}
