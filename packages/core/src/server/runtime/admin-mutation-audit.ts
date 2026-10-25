import { ORPCError, type Meta, type ProcedureClientInterceptorOptions } from '@orpc/server';
import type { AuditWritePort } from '@openora/core/contracts';
import { createLogger } from '../kernel/logger.js';
import { getCurrentTraceId, getRequestAuditTrail } from '../kernel/request-context.js';
import type { OssContext } from '../kernel/router-utils.js';

const logger = createLogger('admin-mutation-audit');

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const DENIAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const REDACTED = '[redacted]';
const SECRET_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'passphrase',
  'secret',
  'token',
  'otp',
  'pin',
  'cvv',
  'mnemonic',
  'seed',
  'credential',
  'authorization',
]);

type ProcedureCall = Pick<
  ProcedureClientInterceptorOptions<OssContext, Record<never, never>, Meta>,
  'procedure' | 'path' | 'input'
> & { next(): Promise<unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecretKey(key: string): boolean {
  if (/api[_-]?key|private[_-]?key/i.test(key)) {
    return true;
  }
  return key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .some((word) => SECRET_WORDS.has(word.replace(/s$/, '')));
}

/** `value` with every field named like a password, token, API key, OTP or other credential masked. */
export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (isRecord(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(
      Object.entries(value).map(([key, field]) => [
        key,
        isSecretKey(key) ? REDACTED : redactSecrets(field),
      ]),
    );
  }
  return value;
}

/** The input's `id`, else its only `*Id` field, when that is a string. */
function resourceIdOf(input: unknown): string | null {
  if (!isRecord(input)) {
    return null;
  }
  if (typeof input['id'] === 'string') {
    return input['id'];
  }
  const ids = Object.entries(input).filter(
    (entry): entry is [string, string] => entry[0].endsWith('Id') && typeof entry[1] === 'string',
  );
  return ids.length === 1 ? ids[0][1] : null;
}

function errorCodeOf(error: unknown): string {
  return error instanceof ORPCError ? error.code : 'INTERNAL_SERVER_ERROR';
}

/**
 * Leaves an audit record for an admin mutation that left none of its own, so no staff
 * intervention goes unrecorded whichever route (core or overlay) carries it. Runs around every
 * procedure; acts only when an admin guard granted a permission and the route is not a read.
 *
 * - Success with nothing audit-worthy noted (an audit write, or a published topic the audit
 *   module covers): one `admin.<resource>.<action>` row holding the route and the redacted input.
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
          input: redactSecrets(input),
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
      trail?.written || [...(trail?.published ?? [])].some((t) => audit.auditedTopics.has(t));
    if (!audited) {
      await record(call, { result: 'success' });
    }
    return output;
  };
}
