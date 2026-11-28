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
export const MCP_TOOL_ID_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const MCP_ACTION_TYPE_ID_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

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
  clientMeta: ClientMetaSchema.optional(),
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
  redact: {
    allow: readonly (keyof z.output<O> & string)[];
    personal?: readonly (keyof z.output<O> & string)[];
  };
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
  benefitsPlayer?: boolean;
  benefitsPlayerWhen?: ActionPayloadMatch;
  distinctBy?: string;
  payloadSchema: P;
  errors: readonly string[];
};

export type ActionPayloadMatch = {
  field: string;
  values: readonly string[];
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
  modelName: string;
  inputJsonSchema: Record<string, unknown>;
  outputJsonSchema: Record<string, unknown>;
};

export type ActionTypeDescriptor = Omit<ActionTypeContract, 'benefitsPlayerWhen' | 'distinctBy'> & {
  benefitsPlayer: boolean;
  benefitsPlayerWhen: ActionPayloadMatch | null;
  distinctBy: string | null;
  owner: string;
  payloadJsonSchema: Record<string, unknown>;
};

export type TriggerSubjectField = 'playerId' | 'userId';

export type TriggerDescriptor = {
  kind: 'event';
  topic: DomainEventName;
  version: number;
  domain: string;
  payloadJsonSchema: Record<string, unknown>;
  subjectField: TriggerSubjectField | null;
};

export const TRIGGER_SUBJECT_OVERRIDES: Partial<
  Record<DomainEventName, TriggerSubjectField | null>
> = {
  'chat.room.invite.sent': null,
  'chat.room.invite.withheld': null,
  'iam.role.assigned': null,
  'iam.role.revoked': null,
  'identity.2fa.enrollment_blocked': null,
  'player.account.closed': null,
  'identity.user.deactivated': null,
};

function subjectFieldOf(topic: DomainEventName): TriggerSubjectField | null {
  if (topic in TRIGGER_SUBJECT_OVERRIDES) {
    return TRIGGER_SUBJECT_OVERRIDES[topic] ?? null;
  }
  const schema: z.ZodType = domainEventSchemas[topic];
  if (!(schema instanceof z.ZodObject)) {
    return null;
  }
  if ('userId' in schema.shape) {
    return 'userId';
  }
  return 'playerId' in schema.shape ? 'playerId' : null;
}

let eventTriggers: readonly TriggerDescriptor[] | undefined;

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
      subjectField: subjectFieldOf(topic),
    };
  });
  return eventTriggers;
}

export type McpInputIssue = { path: string; message: string };
export type McpFailure = { ok: false; error: string; issues?: McpInputIssue[] };
export type McpToolResult = { ok: true; output: Record<string, unknown> } | McpFailure;
export type ActionPreconditionResult = { ok: true } | McpFailure;
export type ActionExecutionResult = ({ ok: true } & ActionExecutionOutcome) | McpFailure;

export type McpKernel = {
  readonly catalogVersion: string;
  listTools(): readonly McpToolDescriptor[];
  listActionTypes(): readonly ActionTypeDescriptor[];
  listTriggers(): readonly TriggerDescriptor[];
  invokeTool(toolId: string, input: unknown, run: RunContext): Promise<McpToolResult>;
  checkPrecondition(
    actionTypeId: string,
    payload: unknown,
    run: RunContext,
  ): Promise<ActionPreconditionResult>;
  executeAction(
    actionTypeId: string,
    payload: unknown,
    context: ActionExecutionContext,
  ): Promise<ActionExecutionResult>;
};

export const MCP_KERNEL: Token<McpKernel> = createToken('MCP_KERNEL');
