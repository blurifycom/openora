import { z } from 'zod';

export const McpToolInputSchema = z.object({
  type: z.literal('object'),
  properties: z.record(z.string(), z.unknown()),
  required: z.array(z.string()).optional(),
});

export const McpToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: McpToolInputSchema,
});

export const McpServerInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
});

export type McpTool = z.infer<typeof McpToolSchema>;
export type McpServerInfo = z.infer<typeof McpServerInfoSchema>;

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
