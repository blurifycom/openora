import { ToolSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  McpFailure,
  McpIamRequirement,
  McpPersonalFieldMode,
  McpToolDescriptor,
  McpToolResult,
  RunContext,
} from '@openora/core/contracts';
import { projectedOutputJsonSchema } from './output-schema.js';

export const CORRELATION_ID_META_KEY = 'openora/correlationId';

const READ_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const ObjectJsonSchema = ToolSchema.shape.inputSchema;

export type ExposedTool = {
  id: McpToolDescriptor['id'];
  iam: McpIamRequirement;
  /** The output keys that reach the client. */
  keys: readonly string[];
  definition: Tool;
};

function objectJsonSchema(
  toolId: McpToolDescriptor['id'],
  role: 'input' | 'output',
  schema: Record<string, unknown>,
) {
  const parsed = ObjectJsonSchema.safeParse(schema);
  if (!parsed.success) {
    throw new Error(
      `[mcp] tool "${toolId}": its ${role} JSON Schema is not an object schema - MCP requires type "object" at the root`,
    );
  }
  return parsed.data;
}

function exposedKeys(descriptor: McpToolDescriptor, personalFields: McpPersonalFieldMode) {
  if (personalFields === 'include') {
    return descriptor.redact.allow;
  }
  const personal = new Set<string>(descriptor.redact.personal ?? []);
  return descriptor.redact.allow.filter((key) => !personal.has(key));
}

/**
 * The read-class tools as MCP tool definitions, named by their model names. In 'drop' mode the
 * keys a tool marks as personal leave both the published output schema and every result.
 * Throws when a tool's input or output schema is not a JSON object schema.
 */
export function exposedTools(
  descriptors: readonly McpToolDescriptor[],
  personalFields: McpPersonalFieldMode,
): ExposedTool[] {
  return descriptors
    .filter((descriptor) => descriptor.class === 'read')
    .map((descriptor) => {
      const keys = exposedKeys(descriptor, personalFields);
      return {
        id: descriptor.id,
        iam: descriptor.iam,
        keys,
        definition: {
          name: descriptor.modelName,
          title: descriptor.title,
          description: descriptor.description,
          inputSchema: objectJsonSchema(descriptor.id, 'input', descriptor.inputJsonSchema),
          outputSchema: objectJsonSchema(
            descriptor.id,
            'output',
            projectedOutputJsonSchema(descriptor.outputSchema, keys),
          ),
          annotations: READ_TOOL_ANNOTATIONS,
        },
      };
    });
}

export function projectOutput(output: Record<string, unknown>, keys: readonly string[]) {
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(output, key) && output[key] !== undefined)
      .map((key) => [key, output[key]]),
  );
}

function failureBody({ error, issues }: McpFailure) {
  return issues ? { error, issues } : { error };
}

/**
 * A kernel result as an MCP tool result. A failure carries only its code and input issues, and
 * no `structuredContent`: the SDK client validates any structured content against the tool's
 * output schema, error results included.
 */
export function toCallToolResult(
  result: McpToolResult,
  keys: readonly string[],
  correlationId: RunContext['correlationId'],
): CallToolResult {
  const _meta = { [CORRELATION_ID_META_KEY]: correlationId };
  if (!result.ok) {
    return {
      content: [{ type: 'text', text: JSON.stringify(failureBody(result)) }],
      isError: true,
      _meta,
    };
  }
  const structuredContent = projectOutput(result.output, keys);
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    _meta,
  };
}
