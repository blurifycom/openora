import * as z from 'zod';
import { ClientMetaSchema, UuidSchema } from '../schemas/common.js';
import type { AdminActionOf, AdminResource } from '../schemas/iam.js';
import {
  DOMAIN_EVENT_CATALOG,
  domainEventSchemas,
  getEventVersion,
  type DomainEventName,
} from '../schemas/events.js';
import { createToken, type Token } from './token.js';

export const MCP_TOOL_CLASSES = ['read', 'propose'] as const;
export const McpToolClassSchema = z.enum(MCP_TOOL_CLASSES);
export type McpToolClass = z.infer<typeof McpToolClassSchema>;

export const AGENT_APPROVAL_LEVELS = ['read_only', 'requires_review', 'automatic'] as const;
export const AgentApprovalLevelSchema = z.enum(AGENT_APPROVAL_LEVELS);
export type AgentApprovalLevel = z.infer<typeof AgentApprovalLevelSchema>;

export const AGENT_PROPOSAL_STATUSES = [
  'open',
  'in_review',
  'approved',
  'rejected',
  'expired',
  'executed',
  'failed',
] as const;
export const AgentProposalStatusSchema = z.enum(AGENT_PROPOSAL_STATUSES);
export type AgentProposalStatus = z.infer<typeof AgentProposalStatusSchema>;

export const TRIGGER_KINDS = ['event', 'schedule', 'manual'] as const;
export const TriggerKindSchema = z.enum(TRIGGER_KINDS);
export type TriggerKind = z.infer<typeof TriggerKindSchema>;

export const MCP_COMMON_ERROR_CODES = [
  'invalid_input',
  'invalid_run_context',
  'forbidden',
  'unknown_tool',
  'unknown_action',
  'output_invalid',
  'audit_unavailable',
  'internal_error',
] as const;
export type McpCommonErrorCode = (typeof MCP_COMMON_ERROR_CODES)[number];

export const MCP_ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;
/** Lowercase dotted segments (eg `player.summary`); an id is also capped at 64 characters. */
export const MCP_TOOL_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const MCP_ACTION_TYPE_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Thrown by a handler, precondition or executor to return a declared error code.
 * The message IS the code - never data.
 */
export class McpToolError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'McpToolError';
  }
}

export const RunActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('admin'), adminId: UuidSchema }),
  z.object({
    kind: z.literal('agent'),
    agentId: UuidSchema,
    agentVersion: z.number().int().positive(),
    onBehalfOf: UuidSchema,
  }),
  z.object({ kind: z.literal('mcp_token'), tokenId: UuidSchema, adminId: UuidSchema }),
]);
export type RunActor = z.infer<typeof RunActorSchema>;

/**
 * The admin whose grants every call is checked against: the admin, the admin an agent
 * acts for, or the token's owner.
 */
export function runActorAdminId(actor: RunActor): string {
  switch (actor.kind) {
    case 'admin':
      return actor.adminId;
    case 'agent':
      return actor.onBehalfOf;
    case 'mcp_token':
      return actor.adminId;
  }
}

export const RunContextSchema = z.object({
  runId: UuidSchema,
  actor: RunActorSchema,
  playerPseudonym: z.string().min(1).max(128).optional(),
  catalogVersion: z.string().min(1).max(128),
  correlationId: z.string().min(1).max(128),
  /** The calling client's address and agent, recorded on the call's audit record. */
  clientMeta: ClientMetaSchema.optional(),
  /** Drops the output keys a tool marks as personal before the result is hashed and returned. */
  dropPersonal: z.boolean().optional(),
});
export type RunContext = z.infer<typeof RunContextSchema>;

export const ActionExecutionContextSchema = z.object({
  proposalId: UuidSchema,
  actor: RunActorSchema,
  correlationId: RunContextSchema.shape.correlationId,
});
export type ActionExecutionContext = z.infer<typeof ActionExecutionContextSchema>;

export type McpIamRequirement = {
  [R in AdminResource]: { resource: R; action: AdminActionOf<R> };
}[AdminResource];

export type McpToolContract<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
> = {
  id: string;
  title: string;
  description: string;
  class: McpToolClass;
  schemaVersion: number;
  iam: McpIamRequirement;
  inputSchema: I;
  outputSchema: O;
  /**
   * allow: top-level output keys that may leave the kernel. personal: the subset carrying
   * personal data a consumer must pseudonymise or drop before a model sees it.
   */
  redact: {
    allow: readonly (keyof z.output<O> & string)[];
    personal?: readonly (keyof z.output<O> & string)[];
  };
  /** Codes the handler may throw via McpToolError. Anything else becomes internal_error. */
  errors: readonly string[];
};

export type McpToolHandler<
  I extends z.ZodObject = z.ZodObject,
  O extends z.ZodObject = z.ZodObject,
> = (input: z.output<I>, run: RunContext) => Promise<z.input<O>>;

export function defineMcpTool<I extends z.ZodObject, O extends z.ZodObject>(
  contract: McpToolContract<I, O>,
): McpToolContract<I, O> {
  return contract;
}

export type ActionTypeContract<P extends z.ZodObject = z.ZodObject> = {
  id: string;
  title: string;
  description: string;
  schemaVersion: number;
  iam: McpIamRequirement;
  reversible: boolean;
  payloadSchema: P;
  /** Codes the precondition may refuse with and the executor may fail with. */
  errors: readonly string[];
};

export const ActionPreconditionOutcomeSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true) }),
  z.object({ ok: z.literal(false), code: z.string() }),
]);
export type ActionPreconditionOutcome = z.infer<typeof ActionPreconditionOutcomeSchema>;

export type ActionPrecondition<P extends z.ZodObject = z.ZodObject> = (
  payload: z.output<P>,
  run: RunContext,
) => Promise<ActionPreconditionOutcome>;

export const ACTION_EXECUTION_OUTCOMES = ['applied', 'already_applied'] as const;
export const ActionExecutionOutcomeSchema = z.object({
  outcome: z.enum(ACTION_EXECUTION_OUTCOMES),
  detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional(),
});
export type ActionExecutionOutcome = z.infer<typeof ActionExecutionOutcomeSchema>;

/**
 * Runs an approved proposal. A replay while the effect still holds must perform nothing and
 * resolve 'already_applied', which makes a retry after a crash safe. Core stores no proposals, so
 * executors key on the resulting state, which may record the proposal id: after someone else
 * changes that state, a replay may apply again or answer a declared refusal, so a proposal store
 * must not re-execute a proposal it recorded as executed.
 */
export type ActionExecutor<P extends z.ZodObject = z.ZodObject> = (
  payload: z.output<P>,
  proposalId: string,
  actor: RunActor,
) => Promise<ActionExecutionOutcome>;

export type ActionTypeImplementation<P extends z.ZodObject = z.ZodObject> = {
  precondition: ActionPrecondition<P>;
  execute: ActionExecutor<P>;
};

export function defineActionType<P extends z.ZodObject>(
  contract: ActionTypeContract<P>,
): ActionTypeContract<P> {
  return contract;
}

export type McpToolDescriptor = McpToolContract & {
  owner: string;
  /**
   * The id with every dot replaced by an underscore. The major model APIs reject dots in
   * function names, so a consumer sends this name to models and MCP clients and maps back.
   */
  modelName: string;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
};

export type ActionTypeDescriptor = ActionTypeContract & {
  owner: string;
  payloadJsonSchema: Record<string, unknown>;
};

export type TriggerDescriptor = {
  kind: 'event';
  topic: DomainEventName;
  version: number;
  domain: string;
  payloadJsonSchema: Record<string, unknown>;
};

let eventTriggers: readonly TriggerDescriptor[] | undefined;

/** Every domain event as a trigger, derived from `domainEventSchemas` once and memoised. */
export function triggerCatalog(): readonly TriggerDescriptor[] {
  eventTriggers ??= DOMAIN_EVENT_CATALOG.map((topic) => {
    const [domain = topic] = topic.split('.');
    return {
      kind: 'event',
      topic,
      version: getEventVersion(topic),
      domain,
      payloadJsonSchema: z.toJSONSchema(domainEventSchemas[topic], {
        target: 'draft-7',
        io: 'output',
        unrepresentable: 'any',
      }),
    };
  });
  return eventTriggers;
}

export type McpInputIssue = { path: string; message: string };
export type McpFailure = { ok: false; error: string; issues?: McpInputIssue[] };
export type McpToolResult = { ok: true; output: Record<string, unknown> } | McpFailure;
export type ActionPreconditionResult = { ok: true } | McpFailure;
export type ActionExecutionResult = ({ ok: true } & ActionExecutionOutcome) | McpFailure;

/**
 * The only way to run an agent-callable tool or action type. Every tool call and action
 * execution is checked against the caller's IAM grant and the input schema, returns only
 * allow-listed output and declared error codes (never an exception message), and leaves
 * exactly one audit record.
 */
export type McpKernel = {
  readonly catalogVersion: string;
  listTools(): readonly McpToolDescriptor[];
  listActionTypes(): readonly ActionTypeDescriptor[];
  listTriggers(): readonly TriggerDescriptor[];
  invokeTool(toolId: string, input: unknown, run: RunContext): Promise<McpToolResult>;
  /**
   * Checks the caller's IAM grant for the action type, as an execution does, and answers
   * `forbidden` without running the precondition when it is missing. Writes no audit record.
   */
  checkPrecondition(
    actionTypeId: string,
    payload: unknown,
    run: RunContext,
  ): Promise<ActionPreconditionResult>;
  /**
   * Does not re-run the precondition: an executor guards its own state under its own
   * locks, and a replay while its effect still holds resolves 'already_applied'. The audit
   * write is retried before the call fails, because the effect is already committed.
   */
  executeAction(
    actionTypeId: string,
    payload: unknown,
    context: ActionExecutionContext,
  ): Promise<ActionExecutionResult>;
};

export const MCP_KERNEL: Token<McpKernel> = createToken('MCP_KERNEL');
