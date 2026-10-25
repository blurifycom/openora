import { ORPCError, type Meta, type ProcedureClientInterceptorOptions } from '@orpc/server';
import { UuidSchema, type AuditWritePort } from '@openora/core/contracts';
import { createLogger } from '../kernel/logger.js';
import { getCurrentTraceId, getRequestAuditTrail } from '../kernel/request-context.js';
import type { OssContext } from '../kernel/router-utils.js';

const logger = createLogger('admin-mutation-audit');

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const DENIAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);
const REDACTED = '[redacted]';
const MAX_INPUT_BYTES = 4096;

const SECRET_WORDS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'passphrase',
  'pass',
  'pwd',
  'secret',
  'cookie',
  'signature',
  'authorization',
  'credential',
  'cvv',
  'mnemonic',
  'seed',
  'apikey',
]);
const EXACT_SECRET_WORDS: ReadonlySet<string> = new Set(['otp', 'totp', 'pin']);
const KEY_QUALIFIERS: ReadonlySet<string> = new Set([
  'api',
  'private',
  'signing',
  'hmac',
  'secret',
  'access',
  'encryption',
  'master',
  'shared',
  'auth',
]);
const PUBLIC_AFTER_TOKEN: ReadonlySet<string> = new Set([
  'address',
  'id',
  'ids',
  'symbol',
  'name',
  'type',
  'amount',
  'decimals',
  'contract',
  'network',
  'standard',
  'count',
]);
const CODE_QUALIFIERS: ReadonlySet<string> = new Set([
  'verification',
  'verify',
  'confirmation',
  'factor',
  'mfa',
  'sms',
  'email',
  'recovery',
  'backup',
]);
const JWT = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const URL_WITH_CREDENTIALS = /^[a-z][a-z\d+.-]*:\/\/[^\s/?#]*@/i;

type ProcedureCall = Pick<
  ProcedureClientInterceptorOptions<OssContext, Record<never, never>, Meta>,
  'procedure' | 'path' | 'input'
> & { next(): Promise<unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const singular = (word: string) => word.replace(/s$/, '');

function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(Boolean);
  return words.some((word, i) => {
    const base = singular(word);
    const next = words[i + 1];
    return (
      SECRET_WORDS.has(word) ||
      SECRET_WORDS.has(base) ||
      EXACT_SECRET_WORDS.has(word) ||
      (base === 'token' && !(next && PUBLIC_AFTER_TOKEN.has(next))) ||
      (base === 'key' && KEY_QUALIFIERS.has(words[i - 1] ?? '')) ||
      (base === 'code' && (words.length === 1 || CODE_QUALIFIERS.has(words[i - 1] ?? '')))
    );
  });
}

function isSecretString(value: string): boolean {
  return JWT.test(value) || URL_WITH_CREDENTIALS.test(value);
}

/** `value` with every field named like a credential, and every string shaped like one, masked. */
export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') {
    return isSecretString(value) ? REDACTED : value;
  }
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

/** The redacted input, or a marker with its size when it is too large (or not serializable) to keep. */
export function storableInput(input: unknown): unknown {
  const redacted = redactSecrets(input);
  try {
    const bytes = Buffer.byteLength(JSON.stringify(redacted) ?? '');
    return bytes > MAX_INPUT_BYTES ? { truncated: true, bytes } : redacted;
  } catch {
    return { truncated: true };
  }
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
          input: storableInput(input),
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
