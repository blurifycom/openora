import { z } from 'zod';

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);

export const MessageSchema = z.object({
  role: MessageRoleSchema,
  content: z.string(),
});

export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});

export const PromptSpecSchema = z.object({
  messages: z.array(MessageSchema),
  tools: z.array(ToolDefinitionSchema).optional(),
  maxTokens: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
});

export const EvalCaseSchema = z.object({
  id: z.string(),
  description: z.string(),
  prompt: PromptSpecSchema,
  expectedToolCall: z
    .object({
      name: z.string(),
      inputMatchers: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  expectedContentContains: z.string().optional(),
});

export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
export type PromptSpec = z.infer<typeof PromptSpecSchema>;
export type EvalCase = z.infer<typeof EvalCaseSchema>;

export interface LLMResponse {
  content: string;
  toolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
  usage?: { inputTokens: number; outputTokens: number };
}
