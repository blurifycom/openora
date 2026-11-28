import { ORPCError, type Meta, type ProcedureClientInterceptorOptions } from '@orpc/server';
import { UuidSchema, type AuditWritePort } from '@openora/core/contracts';
import { sha256Hex } from '../mcp/canonical-json.js';
import { createLogger } from '../kernel/logger.js';
import { getCurrentTraceId, getRequestAuditTrail } from '../kernel/request-context.js';
import type { OssContext } from '../kernel/router-utils.js';

const logger = createLogger('admin-mutation-audit');

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const DENIAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);

type ProcedureCall = Pick<
  ProcedureClientInterceptorOptions<OssContext, Record<never, never>, Meta>,
  'procedure' | 'path' | 'input'
> & { next(): Promise<unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function inputSummary(input: unknown) {
  return {
    inputKeys: isRecord(input) ? Object.keys(input).sort() : [],
    inputHash: sha256Hex(input),
  };
}

function resourceIdOf(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }
  const ids = Object.entries(input).filter(
    (entry): entry is [string, string] => entry[0].endsWith('Id') && typeof entry[1] === 'string',
  );
  const candidate =
    typeof input['id'] === 'string' ? input['id'] : ids.length === 1 ? ids[0][1] : null;
  return UuidSchema.safeParse(candidate).success ? candidate : null;
}

function errorCodeOf(error: unknown): string {
  return error instanceof ORPCError ? error.code : 'INTERNAL_SERVER_ERROR';
}

export function adminMutationAudit(audit: AuditWritePort) {
  async function record(
    { path, input }: Pick<ProcedureCall, 'path' | 'input'>,
    outcome: { result: 'success' } | { result: 'failure'; errorCode: string },
  ) {
    const grant = getRequestAuditTrail()?.grant;
    if (!grant || grant.action === 'view') {
      return;
    }
    const { userId, resource, action, ip, userAgent } = grant;
    try {
      await audit.record({
        actorId: userId,
        actorType: 'admin',
        action: `admin.${resource}.${action}`,
        resourceType: resource,
        resourceId: resourceIdOf(input),
        after: {
          route: path.join('.'),
          ...inputSummary(input),
          ...(outcome.result === 'failure' ? { errorCode: outcome.errorCode } : {}),
        },
        correlationId: getCurrentTraceId() ?? null,
        ip,
        userAgent,
        result: outcome.result,
      });
    } catch (err) {
      logger.error(
        { err, route: path.join('.'), action: `admin.${resource}.${action}` },
        'fallback audit write failed - the admin mutation went unrecorded',
      );
    }
  }

  return async (call: ProcedureCall): Promise<unknown> => {
    if (READ_METHODS.has(call.procedure['~orpc'].route.method ?? 'POST')) {
      return call.next();
    }
    let output: unknown;
    try {
      output = await call.next();
    } catch (error) {
      if (!(error instanceof ORPCError && DENIAL_STATUSES.has(error.status))) {
        await record(call, { result: 'failure', errorCode: errorCodeOf(error) });
      }
      throw error;
    }
    const trail = getRequestAuditTrail();
    const audited =
      (trail?.grant && trail.writtenFor.has(trail.grant.userId)) ||
      [...(trail?.published ?? [])].some((t) => audit.auditedTopics?.has(t));
    if (!audited) {
      await record(call, { result: 'success' });
    }
    return output;
  };
}
