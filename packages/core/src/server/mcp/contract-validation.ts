import * as z from 'zod';
import {
  MCP_ACTION_TYPE_ID_PATTERN,
  MCP_COMMON_ERROR_CODES,
  MCP_ERROR_CODE_PATTERN,
  MCP_TOOL_CLASSES,
  MCP_TOOL_ID_PATTERN,
  adminStatement,
  type ActionTypeContract,
  type McpIamRequirement,
  type McpToolContract,
} from '@openora/core/contracts';

const MAX_ID_LENGTH = 64;
const MAX_TITLE_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 1024;

const INPUT_SHAPE_FIX =
  'models send numbers as strings when a tool input is a oneOf; keep a top-level z.object and put conditional rules in .superRefine()';

const STATEMENT_ACTIONS = new Map<string, readonly string[]>(Object.entries(adminStatement));

// A regex or an open-ended format such as email does not cap length; only these fixed shapes do.
const FIXED_WIDTH_STRING_FORMATS: ReadonlySet<string> = new Set([
  'uuid',
  'date',
  'time',
  'date-time',
]);

type Rejection = { problem: string; fix: string };

type InputLabel = 'inputSchema' | 'payloadSchema';

type SchemaLabel = InputLabel | 'outputSchema';

type McpRegistrationCandidate<Contract> = {
  contract: Contract;
  owner: string;
  factory: unknown;
};

type McpRegistrations = {
  tools: readonly { contract: McpToolContract; owner: string }[];
  actions: readonly { contract: ActionTypeContract; owner: string }[];
};

export function mcpToolModelName(toolId: string): string {
  return toolId.replaceAll('.', '_');
}

/** Throws a `[mcp] tool ...` error naming the first rule the registration breaks. */
export function assertValidMcpTool(
  { contract, owner, factory }: McpRegistrationCandidate<McpToolContract>,
  registered: McpRegistrations,
): void {
  const rejection =
    idRejection(
      contract.id,
      MCP_TOOL_ID_PATTERN,
      'lowercase dotted segments like "player.summary"',
    ) ??
    duplicateIdRejection(contract.id, registered) ??
    modelNameRejection(contract.id, registered.tools) ??
    describedRejection(contract) ??
    toolClassRejection(contract.class) ??
    iamRejection(contract.iam, {
      problem: 'iam is missing',
      fix: 'name the adminStatement resource and action the caller must hold, eg { resource: "player", action: "view" }',
    }) ??
    errorCodesRejection(contract.errors) ??
    factoryRejection(factory, '(c) => async (input, run) => output') ??
    inputSchemaRejection(contract.inputSchema, 'inputSchema') ??
    outputSchemaRejection(contract);
  if (rejection) {
    throw new Error(
      `[mcp] tool "${String(contract.id)}" (plugin "${owner}"): ${rejection.problem} - ${rejection.fix}`,
    );
  }
}

/** Throws a `[mcp] action type ...` error naming the first rule the registration breaks. */
export function assertValidActionType(
  { contract, owner, factory }: McpRegistrationCandidate<ActionTypeContract>,
  registered: McpRegistrations,
): void {
  const rejection =
    idRejection(
      contract.id,
      MCP_ACTION_TYPE_ID_PATTERN,
      'a snake_case verb phrase like "hold_withdrawal"',
    ) ??
    duplicateIdRejection(contract.id, registered) ??
    describedRejection(contract) ??
    reversibleRejection(contract.reversible) ??
    iamRejection(contract.iam, {
      problem: 'every action type must name the IAM resource its executor needs',
      fix: 'add iam: { resource, action } from adminStatement, eg { resource: "withdrawal", action: "hold" }',
    }) ??
    errorCodesRejection(contract.errors) ??
    factoryRejection(factory, '(c) => ({ precondition, execute })') ??
    inputSchemaRejection(contract.payloadSchema, 'payloadSchema');
  if (rejection) {
    throw new Error(
      `[mcp] action type "${String(contract.id)}" (plugin "${owner}"): ${rejection.problem} - ${rejection.fix}`,
    );
  }
}

function idRejection(id: unknown, pattern: RegExp, example: string): Rejection | null {
  if (typeof id === 'string' && id.length <= MAX_ID_LENGTH && pattern.test(id)) {
    return null;
  }
  return {
    problem: `id must match ${pattern} and be at most ${MAX_ID_LENGTH} characters`,
    fix: `use ${example}`,
  };
}

function duplicateIdRejection(id: string, registered: McpRegistrations): Rejection | null {
  const tool = registered.tools.find((entry) => entry.contract.id === id);
  const action = registered.actions.find((entry) => entry.contract.id === id);
  const clash = tool
    ? `a tool of plugin "${tool.owner}"`
    : action
      ? `an action type of plugin "${action.owner}"`
      : null;
  if (!clash) {
    return null;
  }
  return {
    problem: `id is already registered as ${clash}`,
    fix: 'ids are unique across tools and action types; rename one of them',
  };
}

function modelNameRejection(id: string, tools: McpRegistrations['tools']): Rejection | null {
  const modelName = mcpToolModelName(id);
  const clash = tools.find((entry) => mcpToolModelName(entry.contract.id) === modelName);
  if (!clash) {
    return null;
  }
  return {
    problem: `model name "${modelName}" collides with tool "${clash.contract.id}" of plugin "${clash.owner}"`,
    fix: 'models see "." as "_", so pick an id that stays unique after that replacement',
  };
}

function isText(value: unknown, maxLength: number): boolean {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

function describedRejection(contract: {
  title: unknown;
  description: unknown;
  schemaVersion: unknown;
}): Rejection | null {
  if (!isText(contract.title, MAX_TITLE_LENGTH)) {
    return {
      problem: `title must be 1..${MAX_TITLE_LENGTH} characters`,
      fix: 'give a short human-readable name',
    };
  }
  if (!isText(contract.description, MAX_DESCRIPTION_LENGTH)) {
    return {
      problem: `description must be 1..${MAX_DESCRIPTION_LENGTH} characters`,
      fix: 'say what it does and when a model should use it',
    };
  }
  if (!Number.isInteger(contract.schemaVersion) || Number(contract.schemaVersion) < 1) {
    return {
      problem: 'schemaVersion must be a positive integer',
      fix: 'start at 1 and bump it whenever a schema changes shape',
    };
  }
  return null;
}

function toolClassRejection(toolClass: unknown): Rejection | null {
  if (MCP_TOOL_CLASSES.some((known) => known === toolClass)) {
    return null;
  }
  return {
    problem: `class must be one of ${MCP_TOOL_CLASSES.join(', ')}`,
    fix: 'use "read" for a lookup and "propose" for a tool that drafts a proposal',
  };
}

function reversibleRejection(reversible: unknown): Rejection | null {
  if (typeof reversible === 'boolean') {
    return null;
  }
  return {
    problem: 'reversible must be a boolean',
    fix: 'state whether an approved action can be undone',
  };
}

function iamRejection(
  iam: McpIamRequirement | undefined,
  whenMissing: Rejection,
): Rejection | null {
  if (!iam) {
    return whenMissing;
  }
  const actions = STATEMENT_ACTIONS.get(iam.resource);
  if (!actions) {
    return {
      problem: `iam.resource "${String(iam.resource)}" is not in adminStatement`,
      fix: 'use a resource declared in contracts/schemas/iam.ts',
    };
  }
  if (!actions.includes(iam.action)) {
    return {
      problem: `iam.action "${String(iam.action)}" is not an action of "${iam.resource}"`,
      fix: `use one of: ${actions.join(', ')}`,
    };
  }
  return null;
}

function errorCodesRejection(errors: readonly unknown[] | undefined): Rejection | null {
  if (!Array.isArray(errors)) {
    return {
      problem: 'errors must be an array of error codes',
      fix: 'declare errors: [] when nothing throws McpToolError',
    };
  }
  const seen = new Set<string>();
  for (const code of errors) {
    if (typeof code !== 'string' || !MCP_ERROR_CODE_PATTERN.test(code)) {
      return {
        problem: `error code "${String(code)}" must match ${MCP_ERROR_CODE_PATTERN}`,
        fix: 'use a lowercase snake_case code',
      };
    }
    if (MCP_COMMON_ERROR_CODES.some((common) => common === code)) {
      return {
        problem: `error code "${code}" is reserved by the kernel`,
        fix: 'declare a domain-specific code instead',
      };
    }
    if (seen.has(code)) {
      return { problem: `error code "${code}" is declared twice`, fix: 'list each code once' };
    }
    seen.add(code);
  }
  return null;
}

function factoryRejection(factory: unknown, shape: string): Rejection | null {
  if (typeof factory === 'function') {
    return null;
  }
  return { problem: 'factory must be a function', fix: `pass ${shape} as the second argument` };
}

function describeSchema(schema: unknown): string {
  return schema instanceof z.core.$ZodType ? schema._zod.def.type : typeof schema;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fieldLabel(label: string, path: string): string {
  return path ? `${label} field "${path}"` : label;
}

function childPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

function inputSchemaRejection(schema: unknown, label: InputLabel): Rejection | null {
  if (!(schema instanceof z.core.$ZodObject)) {
    return {
      problem: `${label} must be a top-level z.object, not ${describeSchema(schema)}`,
      fix: INPUT_SHAPE_FIX,
    };
  }
  const fieldRejection = zodFieldRejection(schema, { label, path: '', seen: new Set() });
  if (fieldRejection) {
    return fieldRejection;
  }
  let jsonSchema: z.core.JSONSchema.JSONSchema;
  try {
    jsonSchema = z.toJSONSchema(schema, { target: 'draft-7', io: 'input' });
    z.toJSONSchema(schema, { target: 'draft-7', io: 'output' });
  } catch (err) {
    return {
      problem: `${label} cannot be converted to JSON Schema (${errorMessage(err)})`,
      fix: 'use JSON-native types: ISO strings for dates, decimal strings for money, and no transforms',
    };
  }
  if (jsonSchema.type !== 'object' || jsonSchema.oneOf || jsonSchema.anyOf || jsonSchema.allOf) {
    return {
      problem: `${label} must convert to a JSON Schema object without a top-level oneOf/anyOf/allOf`,
      fix: INPUT_SHAPE_FIX,
    };
  }
  return jsonFieldRejection(jsonSchema, label, '');
}

type ZodWalk = { label: InputLabel; path: string; seen: Set<z.core.$ZodType> };

function wrappedSchema(schema: z.core.$ZodType): z.core.$ZodType | null {
  if (
    schema instanceof z.core.$ZodOptional ||
    schema instanceof z.core.$ZodNullable ||
    schema instanceof z.core.$ZodDefault ||
    schema instanceof z.core.$ZodPrefault ||
    schema instanceof z.core.$ZodReadonly ||
    schema instanceof z.core.$ZodCatch ||
    schema instanceof z.core.$ZodNonOptional
  ) {
    return schema._zod.def.innerType;
  }
  return null;
}

function nestedSchemas(schema: z.core.$ZodType, path: string): [z.core.$ZodType, string][] {
  if (schema instanceof z.core.$ZodObject) {
    return Object.entries(schema._zod.def.shape).map(([key, child]) => [
      child,
      childPath(path, key),
    ]);
  }
  if (schema instanceof z.core.$ZodArray) {
    return [[schema._zod.def.element, `${path}[]`]];
  }
  if (schema instanceof z.core.$ZodUnion) {
    return schema._zod.def.options.map((option) => [option, path]);
  }
  if (schema instanceof z.core.$ZodIntersection) {
    return [
      [schema._zod.def.left, path],
      [schema._zod.def.right, path],
    ];
  }
  if (schema instanceof z.core.$ZodTuple) {
    const { items, rest } = schema._zod.def;
    const entries = items.map((item, index): [z.core.$ZodType, string] => [
      item,
      `${path}[${index}]`,
    ]);
    return rest ? [...entries, [rest, `${path}[]`]] : entries;
  }
  return [];
}

function zodFieldRejection(schema: z.core.$ZodType, walk: ZodWalk): Rejection | null {
  if (walk.seen.has(schema)) {
    return null;
  }
  walk.seen.add(schema);
  const field = fieldLabel(walk.label, walk.path);
  const inner = wrappedSchema(schema);
  if (inner) {
    return zodFieldRejection(inner, walk);
  }
  if (schema instanceof z.core.$ZodNumber && schema._zod.def.coerce !== true) {
    return {
      problem: `${field} is a z.number()`,
      fix: 'use z.coerce.number() - models send numbers as strings ("50")',
    };
  }
  if (schema instanceof z.core.$ZodPipe || schema instanceof z.core.$ZodTransform) {
    return {
      problem: `${field} transforms its value`,
      fix: 'a model only sees the pre-transform shape; accept plain data and convert it in the handler',
    };
  }
  if (schema instanceof z.core.$ZodDate) {
    return {
      problem: `${field} is a z.date()`,
      fix: 'models send JSON; use z.iso.date() or z.iso.datetime()',
    };
  }
  for (const [child, path] of nestedSchemas(schema, walk.path)) {
    const rejection = zodFieldRejection(child, { ...walk, path });
    if (rejection) {
      return rejection;
    }
  }
  return null;
}

type JsonSchemaNode = z.core.JSONSchema._JSONSchema;

function isNullSchema(node: JsonSchemaNode): boolean {
  return typeof node === 'object' && node.type === 'null';
}

function isBound(value: unknown): boolean {
  return typeof value === 'number' && Math.abs(value) < Number.MAX_SAFE_INTEGER;
}

function jsonFieldRejection(
  node: JsonSchemaNode,
  label: SchemaLabel,
  path: string,
): Rejection | null {
  const field = fieldLabel(label, path);
  if (typeof node === 'boolean') {
    return node ? untypedRejection(field) : null;
  }
  if (node.$ref !== undefined) {
    return {
      problem: `${field} is recursive`,
      fix: 'flatten the shape; a tool schema must be a finite tree',
    };
  }
  const branches = [...(node.anyOf ?? []), ...(node.oneOf ?? []), ...(node.allOf ?? [])];
  if (branches.length > 0) {
    return firstRejection(
      branches.filter((branch) => !isNullSchema(branch)),
      (branch) => jsonFieldRejection(branch, label, path),
    );
  }
  if (node.const !== undefined || node.enum !== undefined) {
    return null;
  }
  switch (node.type) {
    case 'string':
    case 'number':
    case 'integer':
      return label === 'outputSchema' ? null : unboundedRejection(node, field);
    case 'array':
      return arrayRejection(node, label, path);
    case 'object':
      return objectRejection(node, label, path);
    case 'boolean':
    case 'null':
      return null;
    default:
      return untypedRejection(field);
  }
}

function unboundedRejection(node: z.core.JSONSchema.JSONSchema, field: string): Rejection | null {
  if (node.type === 'string') {
    return node.maxLength !== undefined ||
      (node.format !== undefined && FIXED_WIDTH_STRING_FORMATS.has(node.format))
      ? null
      : {
          problem: `${field} is a string without a maximum length`,
          fix: 'add .max(n); only an enum, a UUID or an ISO date, time or datetime may leave it out',
        };
  }
  return (isBound(node.minimum) || isBound(node.exclusiveMinimum)) &&
    (isBound(node.maximum) || isBound(node.exclusiveMaximum))
    ? null
    : {
        problem: `${field} is a number without both a lower and an upper bound`,
        fix: 'add .min() and .max() so a model cannot send an unbounded value',
      };
}

function untypedRejection(field: string): Rejection {
  return {
    problem: `${field} accepts any value`,
    fix: 'replace z.any()/z.unknown() with a concrete, bounded type',
  };
}

function arrayRejection(
  node: z.core.JSONSchema.JSONSchema,
  label: SchemaLabel,
  path: string,
): Rejection | null {
  if (label !== 'outputSchema' && node.maxItems === undefined) {
    return {
      problem: `${fieldLabel(label, path)} is an array without a maximum length`,
      fix: 'add .max(n)',
    };
  }
  const items = [node.items, node.additionalItems]
    .flat()
    .filter((item): item is JsonSchemaNode => item !== undefined);
  return firstRejection(items, (item) => jsonFieldRejection(item, label, `${path}[]`));
}

function objectRejection(
  node: z.core.JSONSchema.JSONSchema,
  label: SchemaLabel,
  path: string,
): Rejection | null {
  const field = fieldLabel(label, path);
  if (node.properties === undefined) {
    return {
      problem: `${field} is a free-form map`,
      fix: 'declare its keys with z.object({...}) instead of z.record()',
    };
  }
  if (node.additionalProperties !== undefined && node.additionalProperties !== false) {
    return {
      problem: `${field} accepts undeclared keys`,
      fix: 'drop .loose()/.catchall() and declare every key',
    };
  }
  return firstRejection(Object.entries(node.properties), ([key, child]) =>
    jsonFieldRejection(child, label, childPath(path, key)),
  );
}

function firstRejection<T>(
  items: readonly T[],
  check: (item: T) => Rejection | null,
): Rejection | null {
  for (const item of items) {
    const rejection = check(item);
    if (rejection) {
      return rejection;
    }
  }
  return null;
}

function outputSchemaRejection({ outputSchema, redact }: McpToolContract): Rejection | null {
  if (!(outputSchema instanceof z.core.$ZodObject)) {
    return {
      problem: `outputSchema must be a top-level z.object, not ${describeSchema(outputSchema)}`,
      fix: 'wrap the result in an object; redact.allow names its top-level keys',
    };
  }
  let jsonSchema: z.core.JSONSchema.JSONSchema;
  try {
    jsonSchema = z.toJSONSchema(outputSchema, { target: 'draft-7', io: 'output' });
  } catch (err) {
    return {
      problem: `outputSchema cannot be converted to JSON Schema (${errorMessage(err)})`,
      fix: 'outputs are JSON: return ISO strings for dates, decimal strings for money, and no transforms',
    };
  }
  const passThrough = jsonFieldRejection(jsonSchema, 'outputSchema', '');
  if (passThrough) {
    return passThrough;
  }
  const allow: readonly string[] = Array.isArray(redact?.allow) ? redact.allow : [];
  if (allow.length === 0) {
    return {
      problem: 'redact.allow is empty',
      fix: 'list the top-level output keys that may leave the kernel',
    };
  }
  const shape = outputSchema._zod.def.shape;
  const undeclared = allow.find((key) => !Object.hasOwn(shape, key));
  if (undeclared !== undefined) {
    return {
      problem: `redact.allow key "${undeclared}" is not in outputSchema`,
      fix: 'allow only keys the output schema declares',
    };
  }
  const notAllowed = (redact.personal ?? []).find((key) => !allow.includes(key));
  if (notAllowed !== undefined) {
    return {
      problem: `redact.personal key "${notAllowed}" is not in redact.allow`,
      fix: 'a personal key must also be allowed; list it in both or drop it from personal',
    };
  }
  return null;
}
