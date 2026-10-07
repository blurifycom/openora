import { ToolSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  McpFailure,
  McpIamRequirement,
  McpPersonalFieldMode,
  McpToolDescriptor,
  McpToolResult,
  RunContext,
} from '@openora/core/contracts';

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

function droppedKeys(descriptor: McpToolDescriptor, personalFields: McpPersonalFieldMode) {
  return new Set<string>(personalFields === 'drop' ? (descriptor.redact.personal ?? []) : []);
}

function withoutKeys(schema: Tool['inputSchema'], dropped: ReadonlySet<string>) {
  const { properties, required } = schema;
  return {
    ...schema,
    ...(properties && {
      properties: Object.fromEntries(
        Object.entries(properties).filter(([key]) => !dropped.has(key)),
      ),
    }),
    ...(required && { required: required.filter((key) => !dropped.has(key)) }),
  };
}

/**
 * The read-class tools as MCP tool definitions, named by their model names. Each output schema
 * is the kernel's, already narrowed to the allow-listed keys; in 'drop' mode the keys a tool
 * marks as personal leave both it and every result. Throws when a tool's input or output
 * schema is not a JSON object schema.
 */
export function exposedTools(
  descriptors: readonly McpToolDescriptor[],
  personalFields: McpPersonalFieldMode,
): ExposedTool[] {
  return descriptors
    .filter((descriptor) => descriptor.class === 'read')
    .map((descriptor) => {
      const dropped = droppedKeys(descriptor, personalFields);
      return {
        id: descriptor.id,
        iam: descriptor.iam,
        keys: descriptor.redact.allow.filter((key) => !dropped.has(key)),
        definition: {
          name: descriptor.modelName,
          title: descriptor.title,
          description: descriptor.description,
          inputSchema: objectJsonSchema(descriptor.id, 'input', descriptor.inputJsonSchema),
          outputSchema: withoutKeys(
            objectJsonSchema(descriptor.id, 'output', descriptor.outputJsonSchema),
            dropped,
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
