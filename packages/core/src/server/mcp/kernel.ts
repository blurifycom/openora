import * as z from 'zod';
import {
  ActionExecutionContextSchema,
  ActionExecutionOutcomeSchema,
  ActionPreconditionOutcomeSchema,
  McpToolError,
  RunContextSchema,
  runActorAdminId,
  triggerCatalog,
  type ActionExecutionContext,
  type ActionExecutionResult,
  type ActionPreconditionResult,
  type ActionTypeContract,
  type ActionTypeDescriptor,
  type ActionTypeImplementation,
  type AuditWritePort,
  type McpFailure,
  type McpIamRequirement,
  type McpInputIssue,
  type McpKernel,
  type McpToolContract,
  type McpToolDescriptor,
  type McpToolHandler,
  type McpToolResult,
  type RunActor,
  type RunContext,
  type TokenCatalog,
} from '@openora/core/contracts';
import type {
  RegisteredActionType,
  RegisteredMcpTool,
  TypedContainer,
} from '../plugin-host/define-plugin.js';
import { createLogger } from '../kernel/logger.js';
import { sha256Hex } from './canonical-json.js';
import { mcpToolModelName } from './contract-validation.js';

const logger = createLogger('mcp-kernel');

const MAX_INPUT_ISSUES = 20;
const MAX_ISSUE_MESSAGE_LENGTH = 200;
const MAX_UNKNOWN_ID_LENGTH = 128;
const CATALOG_VERSION_LENGTH = 16;
const EXECUTION_AUDIT_ATTEMPTS = 3;
const EXECUTION_AUDIT_RETRY_DELAY_MS = 50;

export type McpAuthorization = 'allowed' | 'denied';

export type McpAuthorizer = (adminId: string, iam: McpIamRequirement) => Promise<McpAuthorization>;

export type McpKernelDeps<C extends TokenCatalog> = {
  tools: readonly RegisteredMcpTool<C>[];
  actions: readonly RegisteredActionType<C>[];
  container: TypedContainer<C>;
  authorize: McpAuthorizer;
  audit: AuditWritePort | null;
};

type ServedTool = {
  contract: McpToolContract;
  handler: McpToolHandler;
  descriptor: McpToolDescriptor;
};

type ServedAction = {
  contract: ActionTypeContract;
  implementation: ActionTypeImplementation;
  descriptor: ActionTypeDescriptor;
};

type KernelState = {
  tools: ReadonlyMap<string, ServedTool>;
  actions: ReadonlyMap<string, ServedAction>;
  authorize: McpAuthorizer;
  audit: AuditWritePort | null;
};

type AuditEntry = Parameters<AuditWritePort['record']>[0];

type ToolOutcome = { result: McpToolResult; inputHash?: string; outputHash?: string };

type ExecutionOutcome = { result: ActionExecutionResult; payloadHash: string };

/**
 * Builds the kernel behind MCP_KERNEL: runs every tool and action-type factory once,
 * precomputes the descriptors, and wraps every call in IAM, schema validation, error-code
 * mapping and one audit record. Throws when a factory throws or returns the wrong shape,
 * so a broken registration fails boot.
 */
export function createMcpKernel<C extends TokenCatalog>(deps: McpKernelDeps<C>): McpKernel {
  const tools = indexById(
    deps.tools.map((tool) => serveTool(tool, deps.container)),
    'tool',
  );
  const actions = indexById(
    deps.actions.map((action) => serveAction(action, deps.container)),
    'action type',
  );
  if (!deps.audit && (tools.size > 0 || actions.size > 0)) {
    logger.warn('no AUDIT_WRITER is bound: every MCP call will fail with audit_unavailable');
  }
  const state: KernelState = { tools, actions, authorize: deps.authorize, audit: deps.audit };
  const toolDescriptors = [...tools.values()].map((tool) => tool.descriptor);
  const actionDescriptors = [...actions.values()].map((action) => action.descriptor);

  return {
    catalogVersion: catalogVersionOf(deps.tools, deps.actions),
    listTools: () => toolDescriptors,
    listActionTypes: () => actionDescriptors,
    listTriggers: () => triggerCatalog(),
    invokeTool: (toolId, input, run) => invokeTool(state, { toolId, input, run }),
    checkPrecondition: (actionTypeId, payload, run) =>
      checkPrecondition(state, { actionTypeId, payload, run }),
    executeAction: (actionTypeId, payload, context) =>
      executeAction(state, { actionTypeId, payload, context }),
  };
}

function serveTool<C extends TokenCatalog>(
  { contract, owner, factory }: RegisteredMcpTool<C>,
  container: TypedContainer<C>,
): ServedTool {
  const handler = factory(container);
  if (typeof handler !== 'function') {
    throw new Error(
      `[mcp] tool "${contract.id}" (plugin "${owner}"): factory returned no handler - return async (input, run) => output`,
    );
  }
  return {
    contract,
    handler,
    descriptor: {
      ...contract,
      owner,
      modelName: mcpToolModelName(contract.id),
      inputJsonSchema: z.toJSONSchema(contract.inputSchema, { target: 'draft-7', io: 'input' }),
      outputJsonSchema: z.toJSONSchema(contract.outputSchema, { target: 'draft-7', io: 'output' }),
    },
  };
}

function serveAction<C extends TokenCatalog>(
  { contract, owner, factory }: RegisteredActionType<C>,
  container: TypedContainer<C>,
): ServedAction {
  const implementation = factory(container);
  if (
    typeof implementation?.precondition !== 'function' ||
    typeof implementation.execute !== 'function'
  ) {
    throw new Error(
      `[mcp] action type "${contract.id}" (plugin "${owner}"): factory returned no { precondition, execute } pair - return both functions`,
    );
  }
  return {
    contract,
    implementation,
    descriptor: {
      ...contract,
      owner,
      payloadJsonSchema: z.toJSONSchema(contract.payloadSchema, {
        target: 'draft-7',
        io: 'input',
      }),
    },
  };
}

function indexById<T extends { contract: { id: string } }>(
  entries: readonly T[],
  kind: string,
): ReadonlyMap<string, T> {
  const byId = new Map<string, T>();
  for (const entry of entries) {
    if (byId.has(entry.contract.id)) {
      throw new Error(`[mcp] ${kind} "${entry.contract.id}" is registered twice`);
    }
    byId.set(entry.contract.id, entry);
  }
  return byId;
}

function compareText(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function catalogVersionOf(
  tools: readonly { contract: McpToolContract }[],
  actions: readonly { contract: ActionTypeContract }[],
): string {
  const entries = [
    ...tools.map(({ contract }) => ['tool', contract.id, contract.schemaVersion] as const),
    ...actions.map(({ contract }) => ['action', contract.id, contract.schemaVersion] as const),
  ].sort(([leftKind, leftId], [rightKind, rightId]) =>
    leftKind === rightKind ? compareText(leftId, rightId) : compareText(leftKind, rightKind),
  );
  return sha256Hex(entries).slice(0, CATALOG_VERSION_LENGTH);
}

function failure(error: string, issues?: McpInputIssue[]): McpFailure {
  return issues ? { ok: false, error, issues } : { ok: false, error };
}

function issuePaths(error: z.core.$ZodError): string[] {
  return error.issues.map((issue) => issue.path.map(String).join('.'));
}

function invalidInput(error: z.core.$ZodError): McpFailure {
  return failure(
    'invalid_input',
    error.issues.slice(0, MAX_INPUT_ISSUES).map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message.slice(0, MAX_ISSUE_MESSAGE_LENGTH),
    })),
  );
}

type Parsed =
  | { success: true; data: Record<string, unknown> }
  | { success: false; failure: McpFailure };

function parseInput(
  schema: z.ZodObject,
  value: unknown,
  logContext: Record<string, string>,
): Parsed {
  try {
    const parsed = z.safeParse(schema, value);
    return parsed.success
      ? { success: true, data: parsed.data }
      : { success: false, failure: invalidInput(parsed.error) };
  } catch (err) {
    logger.error({ err, ...logContext }, 'mcp input schema threw while parsing');
    return { success: false, failure: failure('internal_error') };
  }
}

function boundedId(id: unknown): string {
  return String(id).slice(0, MAX_UNKNOWN_ID_LENGTH);
}

function withoutUndefined(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}

function actorAuditFields(actor: RunActor): Record<string, unknown> {
  switch (actor.kind) {
    case 'admin':
      return { actorKind: actor.kind };
    case 'agent':
      return { actorKind: actor.kind, agentId: actor.agentId, agentVersion: actor.agentVersion };
    case 'mcp_token':
      return { actorKind: actor.kind, tokenId: actor.tokenId };
  }
}

async function authorizeActor(
  authorize: McpAuthorizer,
  actor: RunActor,
  iam: McpIamRequirement,
): Promise<McpAuthorization | 'failed'> {
  try {
    return await authorize(runActorAdminId(actor), iam);
  } catch (err) {
    logger.error({ err, resource: iam.resource, action: iam.action }, 'mcp authorization failed');
    return 'failed';
  }
}

function authorizationFailure(decision: McpAuthorization | 'failed'): McpFailure | null {
  if (decision === 'allowed') {
    return null;
  }
  return failure(decision === 'denied' ? 'forbidden' : 'internal_error');
}

function declaredCode(
  err: unknown,
  declared: readonly string[],
  context: Record<string, string>,
): string {
  if (err instanceof McpToolError && declared.includes(err.code)) {
    return err.code;
  }
  logger.error({ err, ...context }, 'mcp call failed with an undeclared error');
  return 'internal_error';
}

function pickAllowed(
  output: Record<string, unknown>,
  allow: readonly string[],
): Record<string, unknown> {
  return withoutUndefined(Object.fromEntries(allow.map((key) => [key, output[key]])));
}

async function recordAudit(audit: AuditWritePort | null, entry: AuditEntry): Promise<boolean> {
  if (!audit) {
    return false;
  }
  try {
    await audit.record(entry);
    return true;
  } catch (err) {
    logger.error(
      { err, action: entry.action, resourceId: entry.resourceId },
      'mcp audit write failed',
    );
    return false;
  }
}

// An executor's effect is already committed when its audit record is written, so a transient
// write failure is retried here instead of being handed back as a failure the caller replays -
// by then the state may have moved on, and the replay would report an applied action as refused.
async function recordExecutionAudit(
  audit: AuditWritePort | null,
  entry: AuditEntry,
): Promise<boolean> {
  for (let attempt = 1; attempt <= EXECUTION_AUDIT_ATTEMPTS; attempt += 1) {
    if (await recordAudit(audit, entry)) {
      return true;
    }
    if (!audit || attempt === EXECUTION_AUDIT_ATTEMPTS) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, EXECUTION_AUDIT_RETRY_DELAY_MS * attempt));
  }
  return false;
}

async function invokeTool(
  state: KernelState,
  call: { toolId: string; input: unknown; run: unknown },
): Promise<McpToolResult> {
  const run = RunContextSchema.safeParse(call.run);
  if (!run.success) {
    logger.warn(
      { toolId: boundedId(call.toolId), issuePaths: issuePaths(run.error) },
      'mcp tool call refused: invalid run context',
    );
    return failure('invalid_run_context');
  }
  const tool = state.tools.get(call.toolId);
  const toolId = tool ? tool.contract.id : boundedId(call.toolId);
  const outcome = await toolOutcome(state, { tool, toolId, input: call.input, run: run.data });
  const audited = await recordAudit(state.audit, {
    actorId: runActorAdminId(run.data.actor),
    actorType: 'admin',
    action: outcome.result.ok ? 'mcp.tool.invoked' : 'mcp.tool.failed',
    resourceType: 'mcp-tool',
    resourceId: toolId,
    correlationId: run.data.correlationId,
    after: withoutUndefined({
      toolId,
      toolClass: tool?.contract.class,
      schemaVersion: tool?.contract.schemaVersion,
      runId: run.data.runId,
      ...actorAuditFields(run.data.actor),
      playerPseudonym: run.data.playerPseudonym,
      catalogVersion: run.data.catalogVersion,
      inputHash: outcome.inputHash,
      outputHash: outcome.outputHash,
      error: outcome.result.ok ? undefined : outcome.result.error,
    }),
  });
  return audited ? outcome.result : failure('audit_unavailable');
}

async function toolOutcome(
  state: KernelState,
  {
    tool,
    toolId,
    input,
    run,
  }: { tool: ServedTool | undefined; toolId: string; input: unknown; run: RunContext },
): Promise<ToolOutcome> {
  try {
    if (!tool) {
      return { result: failure('unknown_tool'), inputHash: sha256Hex(input ?? {}) };
    }
    return await runTool(state, tool, input, run);
  } catch (err) {
    logger.error({ err, toolId, runId: run.runId }, 'mcp tool call failed outside its handler');
    return { result: failure('internal_error') };
  }
}

async function runTool(
  state: KernelState,
  tool: ServedTool,
  input: unknown,
  run: RunContext,
): Promise<ToolOutcome> {
  const rawInput = input ?? {};
  const refusal = authorizationFailure(
    await authorizeActor(state.authorize, run.actor, tool.contract.iam),
  );
  if (refusal) {
    return { result: refusal, inputHash: sha256Hex(rawInput) };
  }
  const logContext = { toolId: tool.contract.id, runId: run.runId };
  const parsed = parseInput(tool.contract.inputSchema, rawInput, logContext);
  if (!parsed.success) {
    return { result: parsed.failure, inputHash: sha256Hex(rawInput) };
  }
  const inputHash = sha256Hex(parsed.data);
  try {
    const output = z.safeParse(tool.contract.outputSchema, await tool.handler(parsed.data, run));
    if (!output.success) {
      logger.error(
        { ...logContext, issuePaths: issuePaths(output.error) },
        'mcp tool output does not match its outputSchema',
      );
      return { result: failure('output_invalid'), inputHash };
    }
    const redacted = pickAllowed(output.data, tool.contract.redact.allow);
    return { result: { ok: true, output: redacted }, inputHash, outputHash: sha256Hex(redacted) };
  } catch (err) {
    return { result: failure(declaredCode(err, tool.contract.errors, logContext)), inputHash };
  }
}

async function checkPrecondition(
  state: KernelState,
  call: { actionTypeId: string; payload: unknown; run: unknown },
): Promise<ActionPreconditionResult> {
  const run = RunContextSchema.safeParse(call.run);
  if (!run.success) {
    logger.warn(
      { actionTypeId: boundedId(call.actionTypeId), issuePaths: issuePaths(run.error) },
      'mcp precondition refused: invalid run context',
    );
    return failure('invalid_run_context');
  }
  const action = state.actions.get(call.actionTypeId);
  if (!action) {
    return failure('unknown_action');
  }
  const refusal = authorizationFailure(
    await authorizeActor(state.authorize, run.data.actor, action.contract.iam),
  );
  if (refusal) {
    return refusal;
  }
  const logContext = { actionTypeId: action.contract.id, runId: run.data.runId };
  const parsed = parseInput(action.contract.payloadSchema, call.payload ?? {}, logContext);
  if (!parsed.success) {
    return parsed.failure;
  }
  try {
    const outcome = ActionPreconditionOutcomeSchema.safeParse(
      await action.implementation.precondition(parsed.data, run.data),
    );
    if (!outcome.success) {
      logger.error(logContext, 'mcp precondition returned no { ok } outcome');
      return failure('internal_error');
    }
    if (outcome.data.ok) {
      return { ok: true };
    }
    if (action.contract.errors.includes(outcome.data.code)) {
      return failure(outcome.data.code);
    }
    logger.error(
      { ...logContext, code: outcome.data.code },
      'mcp precondition refused with an undeclared code',
    );
    return failure('internal_error');
  } catch (err) {
    return failure(declaredCode(err, action.contract.errors, logContext));
  }
}

async function executeAction(
  state: KernelState,
  call: { actionTypeId: string; payload: unknown; context: unknown },
): Promise<ActionExecutionResult> {
  const context = ActionExecutionContextSchema.safeParse(call.context);
  if (!context.success) {
    logger.warn(
      { actionTypeId: boundedId(call.actionTypeId), issuePaths: issuePaths(context.error) },
      'mcp action execution refused: invalid run context',
    );
    return failure('invalid_run_context');
  }
  const { proposalId, actor, correlationId } = context.data;
  const action = state.actions.get(call.actionTypeId);
  const outcome = action
    ? await runExecution(state, action, call.payload, context.data)
    : { result: failure('unknown_action'), payloadHash: sha256Hex(call.payload ?? {}) };
  const audited = await recordExecutionAudit(state.audit, {
    actorId: runActorAdminId(actor),
    actorType: 'admin',
    action: outcome.result.ok ? 'mcp.action.executed' : 'mcp.action.failed',
    resourceType: 'agent-proposal',
    resourceId: proposalId,
    correlationId,
    after: withoutUndefined({
      actionTypeId: action ? action.contract.id : boundedId(call.actionTypeId),
      schemaVersion: action?.contract.schemaVersion,
      proposalId,
      ...actorAuditFields(actor),
      payloadHash: outcome.payloadHash,
      outcome: outcome.result.ok ? outcome.result.outcome : undefined,
      error: outcome.result.ok ? undefined : outcome.result.error,
    }),
  });
  return audited ? outcome.result : failure('audit_unavailable');
}

async function runExecution(
  state: KernelState,
  action: ServedAction,
  payload: unknown,
  { proposalId, actor }: ActionExecutionContext,
): Promise<ExecutionOutcome> {
  const rawPayload = payload ?? {};
  const refusal = authorizationFailure(
    await authorizeActor(state.authorize, actor, action.contract.iam),
  );
  if (refusal) {
    return { result: refusal, payloadHash: sha256Hex(rawPayload) };
  }
  const logContext = { actionTypeId: action.contract.id, proposalId };
  const parsed = parseInput(action.contract.payloadSchema, rawPayload, logContext);
  if (!parsed.success) {
    return { result: parsed.failure, payloadHash: sha256Hex(rawPayload) };
  }
  const payloadHash = sha256Hex(parsed.data);
  try {
    const outcome = ActionExecutionOutcomeSchema.safeParse(
      await action.implementation.execute(parsed.data, proposalId, actor),
    );
    if (!outcome.success) {
      logger.error(logContext, 'mcp executor returned no applied/already_applied outcome');
      return { result: failure('internal_error'), payloadHash };
    }
    return { result: { ok: true, ...outcome.data }, payloadHash };
  } catch (err) {
    return {
      result: failure(declaredCode(err, action.contract.errors, logContext)),
      payloadHash,
    };
  }
}
