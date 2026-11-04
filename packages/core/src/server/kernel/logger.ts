import { isSpanContextValid, trace } from '@opentelemetry/api';
import { DrizzleQueryError } from 'drizzle-orm';
import { pino, levels, type Logger } from 'pino';
import { reportError } from './error-reporter.js';
import { getCurrentRequestContext } from './request-context.js';

/**
 * One logger.error({ err }, msg) both logs and reports: this hook forwards every
 * error-level log carrying an `err` to the bound error reporter (an ERROR_TRACKING
 * overlay - Sentry/PostHog/...), so no call site makes a separate capture call and
 * child loggers are covered too. `report: false` opts a noisy/expected error out of
 * forwarding (still logged); a log without `err` is never reported.
 */
/**
 * pino reads no environment of its own; this is where LOG_LEVEL is honoured.
 *
 * `silent` is served by discarding the output rather than by pino's own silent level:
 * a disabled level never reaches `logMethod`, and the error-reporter hook below lives
 * there - so asking for quiet logs would silently also stop reporting errors to the
 * bound tracker. The test suites run at this setting.
 */
const DISCARD = { write() {} };

function levelAndDestination(): [string, typeof DISCARD | undefined] {
  const level = process.env['LOG_LEVEL'] ?? 'info';
  return level === 'silent' ? ['info', DISCARD] : [level, undefined];
}

export function activeTraceLogFields(): Record<string, string> {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !isSpanContextValid(spanContext)) {
    return {};
  }
  return { trace_id: spanContext.traceId, span_id: spanContext.spanId };
}

const QUERY_VALUE_FIELDS: ReadonlySet<string> = new Set(['params']);
const PG_VALUE_FIELDS: ReadonlySet<string> = new Set([
  'detail',
  'where',
  'internalQuery',
  'internalPosition',
]);
const NO_VALUE_FIELDS: ReadonlySet<string> = new Set();

const REDACTED_FIELDS = [
  'password',
  'currentPassword',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'sessionToken',
  'email',
  'phone',
  'phoneNumber',
  'dateOfBirth',
  'firstName',
  'lastName',
  'username',
  'address',
  'walletAddress',
  'depositAddress',
  'balance',
  'pin',
  'otp',
  'backupCode',
] as const;

const REDACTED_KEYS: ReadonlySet<string> = new Set(REDACTED_FIELDS);
const REDACTED = '[redacted]';
const SQLSTATE = /^[0-9A-Z]{5}$/;

function isError(value: unknown): value is Error {
  return value instanceof Error && typeof value.message === 'string';
}

function sqlState(err: Error) {
  const code: unknown = Reflect.get(err, 'code');
  return 'routine' in err && typeof code === 'string' && SQLSTATE.test(code) ? code : undefined;
}

function valueFields(err: Error) {
  if (err instanceof DrizzleQueryError) {
    return QUERY_VALUE_FIELDS;
  }
  return sqlState(err) === undefined ? NO_VALUE_FIELDS : PG_VALUE_FIELDS;
}

/** Postgres data exceptions quote the rejected input, and RAISE EXCEPTION text is free-form. */
function safeMessage(err: Error) {
  if (err instanceof DrizzleQueryError) {
    return `Failed query: ${err.query}`;
  }
  const state = sqlState(err);
  if (state === 'P0001') {
    return `raised exception (${state})`;
  }
  if (!state?.startsWith('22')) {
    return err.message;
  }
  const cut = err.message.indexOf(': ');
  return (cut === -1 ? err.message : err.message.slice(0, cut)).replace(/".*"/s, '"?"');
}

function safeStack(err: Error) {
  const message = safeMessage(err);
  if (err.stack === undefined || message === err.message) {
    return err.stack ?? '';
  }
  const header = `${err.name}: ${err.message}`;
  const frames = err.stack.startsWith(header) ? err.stack.slice(header.length) : '';
  return `${err.name}: ${message}${frames}`;
}

function innerErrors(err: Error) {
  const errors: unknown = Reflect.get(err, 'errors');
  return [err.cause, ...(Array.isArray(errors) ? errors : []), ...Object.values(err)].filter(
    isError,
  );
}

function carriesBoundValues(err: Error, seen: Set<Error>): boolean {
  if (seen.has(err)) {
    return false;
  }
  seen.add(err);
  const fields = valueFields(err);
  return (
    safeMessage(err) !== err.message ||
    Object.keys(err).some((key) => fields.has(key)) ||
    innerErrors(err).some((inner) => carriesBoundValues(inner, seen))
  );
}

function causeChain(err: Error) {
  const chain: Error[] = [];
  for (let link: unknown = err; isError(link) && !chain.includes(link); link = link.cause) {
    chain.push(link);
  }
  return chain;
}

function scrubbed(err: Error, ancestors: ReadonlySet<Error>): Record<string, unknown> {
  const path = new Set(ancestors).add(err);
  const chain = causeChain(err);
  const dropped = valueFields(err);
  const fields = Object.entries(pino.stdSerializers.err(err))
    .filter(([key]) => !dropped.has(key))
    .flatMap(([key, value]) => {
      const raw: unknown = Reflect.get(err, key);
      if (!isError(raw)) {
        return [[key, value]];
      }
      return path.has(raw) ? [] : [[key, scrubbed(raw, path)]];
    });
  const errors: unknown = Reflect.get(err, 'errors');
  const cause = isError(err.cause) && !path.has(err.cause) ? err.cause : undefined;
  return {
    ...Object.fromEntries(fields),
    message: chain.map(safeMessage).join(': '),
    stack: chain.map(safeStack).join('\ncaused by: '),
    ...(Array.isArray(errors)
      ? {
          aggregateErrors: errors
            .filter((inner) => !path.has(inner))
            .map((inner) => (isError(inner) ? scrubbed(inner, path) : inner)),
        }
      : {}),
    ...(cause ? { cause: withoutText(scrubbed(cause, path)) } : {}),
  };
}

function withoutText(serialized: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(serialized).filter(([key]) => key !== 'message' && key !== 'stack'),
  );
}

/** pino's own err serializer duck-types its input although its typings say `Error`. */
function stockErr(value: unknown): unknown {
  return Reflect.apply(pino.stdSerializers.err, undefined, [value]);
}

/**
 * pino's default `err` serializer writes a drizzle query error's message and stack, which
 * carry the bound parameters; a postgres error's `detail` and `where` carry row values.
 */
export function safeErr(err: unknown) {
  return isError(err) && carriesBoundValues(err, new Set())
    ? scrubbed(err, new Set())
    : stockErr(err);
}

function reportable(err: Error, ancestors: ReadonlySet<Error>): Error {
  const path = new Set(ancestors).add(err);
  const cause =
    isError(err.cause) && !path.has(err.cause) ? reportable(err.cause, path) : undefined;
  const dropped = valueFields(err);
  const fields = Object.entries(err).filter(
    ([key, value]) => key !== 'cause' && !dropped.has(key) && !isError(value),
  );
  return Object.assign(
    new Error(safeMessage(err), cause ? { cause } : {}),
    Object.fromEntries(fields),
    { name: err.name, stack: safeStack(err) },
  );
}

/** The error the bound reporter receives: the original unless it carries bound values. */
export function reportableError(err: unknown) {
  return isError(err) && carriesBoundValues(err, new Set()) ? reportable(err, new Set()) : err;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
  );
}

function censored(key: string, value: unknown) {
  return REDACTED_KEYS.has(key) ? REDACTED : value;
}

function censoredField(key: string, value: unknown) {
  if (REDACTED_KEYS.has(key) || !isPlainRecord(value)) {
    return censored(key, value);
  }
  return Object.fromEntries(
    Object.entries(value).map(([inner, field]) => [inner, censored(inner, field)]),
  );
}

/** One level deep: pino's own `*.key` redact paths cost about ten times more per line. */
function censoredFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, value]) => [key, censoredField(key, value)]),
  );
}

function reportedFields(fields: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(censoredFields(fields)).map(([key, value]) => [key, reportableError(value)]),
  );
}

function messageSource(first: unknown): unknown {
  if (first instanceof Error || !first || typeof first !== 'object') {
    return first;
  }
  return Reflect.get(first, 'msg') === undefined ? Reflect.get(first, 'err') : undefined;
}

/** pino falls back to the raw error's message as `msg` when the call passes none. */
function fallbackMessage(first: unknown) {
  const err = messageSource(first);
  if (!isError(err)) {
    return undefined;
  }
  const message = safeMessage(err);
  return message === err.message ? undefined : message;
}

export function createLogger(name: string): Logger {
  const [level, destination] = levelAndDestination();
  return pino(
    {
      name,
      level,
      mixin: activeTraceLogFields,
      serializers: { err: safeErr },
      formatters: { log: censoredFields },
      // Child bindings skip `formatters`; these top-level paths cover them.
      redact: { paths: [...REDACTED_FIELDS], censor: REDACTED },
      hooks: {
        logMethod(inputArgs, method, level) {
          const [first, second] = inputArgs;
          const message =
            second === undefined && inputArgs.length <= 2 ? fallbackMessage(first) : undefined;
          method.apply(this, message === undefined ? inputArgs : [first, message]);

          if (level < levels.values['error']) {
            return;
          }
          if (!first || typeof first !== 'object' || !('err' in first)) {
            return;
          }

          const { err, report, ...rest } = first as {
            err?: unknown;
            report?: boolean;
          } & Record<string, unknown>;
          if (!err || report === false) {
            return;
          }

          const ctx = getCurrentRequestContext();
          const extra = reportedFields(rest);
          reportError(reportableError(err), {
            ...(ctx?.userId ? { userId: ctx.userId } : {}),
            ...(ctx?.traceId ? { traceId: ctx.traceId } : {}),
            extra: typeof second === 'string' ? { ...extra, message: second } : extra,
          });
        },
      },
    },
    destination,
  );
}
