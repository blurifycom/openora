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

/** What the row keeps of the input: its field names and a hash, never a value that could be a credential. */
export function inputSummary(input: unknown) {
  return {
    inputKeys: isRecord(input) ? Object.keys(input).sort() : [],
    inputHash: sha256Hex(input),
  };
}

/** The input's `id`, else its only `*Id` field, when that is a UUID. */
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

/**
 * Leaves an audit record for an admin mutation that left none of its own, so no staff
 * intervention goes unrecorded whichever route (core or overlay) carries it. Runs around every
 * procedure; acts only when an admin guard granted a permission and the route is not a read.
 *
 * - Success with nothing audit-worthy noted (an audit row for the granted admin, or a published
 *   topic the audit module covers): one `admin.<resource>.<action>` row holding the route, the
 *   input's field names and its hash.
 * - A handler error other than an authorization denial: a failure row, even if something
 *   audit-worthy was noted, since a row written inside the rolled-back transaction is gone.
 *
 * The write fails open. After a committed mutation, refusing the response would not undo it and
 * would invite a retry that repeats it, so a failed write is logged at error level (and reaches
 * the error tracker) while the caller still gets the outcome. A failure row never masks the
 * handler's own error.
 */
export function adminMutationAudit(audit: AuditWritePort) {
  async function record(
    { path, input }: Pick<ProcedureCall, 'path' | 'input'>,
    outcome: { result: 'success' } | { result: 'failure'; errorCode: string },
  ) {
    const grant = getRequestAuditTrail()?.grant;
    // A `view` grant on a POST is a search or preview, not an intervention.
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
