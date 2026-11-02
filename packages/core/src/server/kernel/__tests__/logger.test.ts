import { describe, it, expect, vi, afterEach } from 'vitest';
import { TraceFlags, trace } from '@opentelemetry/api';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError } from 'pg';
import { pino } from 'pino';
import { activeTraceLogFields, createLogger, reportableError, safeErr } from '../logger.js';
import { setErrorReporter } from '../error-reporter.js';

afterEach(() => {
  setErrorReporter(undefined);
  vi.restoreAllMocks();
});

describe('createLogger error-reporter hook', () => {
  it('forwards an error-level log carrying `err` to the bound reporter', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    const err = new Error('boom');
    createLogger('test').error({ err, event: 'x' }, 'something failed');

    expect(reporter).toHaveBeenCalledTimes(1);
    expect(reporter).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ extra: { event: 'x', message: 'something failed' } }),
    );
  });

  it('does not report error logs without an `err`', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    createLogger('test').error({ issues: [] }, 'validation failed');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('does not report an error log opted out with `report: false`', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    createLogger('test').error({ err: new Error('boom'), report: false }, 'expected, retrying');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('does not report non-error levels', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);

    createLogger('test').warn({ err: new Error('x') }, 'a warning');

    expect(reporter).not.toHaveBeenCalled();
  });

  it('swallows reporter failures', () => {
    setErrorReporter(() => {
      throw new Error('reporter failed');
    });

    expect(() =>
      createLogger('test').error({ err: new Error('x') }, 'reporter failure'),
    ).not.toThrow();
  });

  it('is inert when no reporter is bound', () => {
    expect(() => createLogger('test').error({ err: new Error('x') }, 'no reporter')).not.toThrow();
  });
});

const SESSION_TOKEN = 'tok_abc123def456ghi789';
const EMAIL = 'player@example.test';
const FAILED_SQL = 'insert into "session" ("token", "email") values ($1, $2)';

function capturedLogger() {
  const lines: string[] = [];
  const logger = createLogger('test');
  Reflect.set(logger, pino.symbols.streamSym, { write: (line: string) => lines.push(line) });
  return { logger, lines };
}

function uniqueViolation() {
  return Object.assign(
    new DatabaseError('duplicate key value violates unique constraint', 0, 'error'),
    {
      code: '23505',
      detail: `Key (token, email)=(${SESSION_TOKEN}, ${EMAIL}) already exists.`,
      where: `SQL statement "insert ... ${EMAIL}"`,
      internalQuery: `select '${SESSION_TOKEN}'`,
      internalPosition: '8',
      constraint: 'session_token_unique',
      table: 'session',
      column: 'token',
      routine: '_bt_check_unique',
    },
  );
}

describe('createLogger err serializer', () => {
  it('logs a failed query without its bound values', () => {
    const { logger, lines } = capturedLogger();

    logger.error(
      {
        err: new DrizzleQueryError(FAILED_SQL, [SESSION_TOKEN, EMAIL], uniqueViolation()),
        report: false,
      },
      'query failed',
    );

    const [line = ''] = lines;
    expect(line).not.toContain(SESSION_TOKEN);
    expect(line).not.toContain(EMAIL);
    expect(line).not.toContain('params');
    const { err } = JSON.parse(line);
    expect(err.message).toBe(
      `Failed query: ${FAILED_SQL}: duplicate key value violates unique constraint`,
    );
    expect(err.stack).toMatch(/^Error: Failed query: insert into "session"[^\n]*\n\s+at /);
    expect(err.query).toBe(FAILED_SQL);
    expect(err.cause).toMatchObject({ type: 'DatabaseError', code: '23505' });
    expect(err.cause).not.toHaveProperty('detail');
  });

  it('keeps the database error fields that carry no row values', () => {
    const err = new DrizzleQueryError(FAILED_SQL, [SESSION_TOKEN], uniqueViolation());
    const nested = Object.assign(new Error('outer', { cause: err }), { original: err });

    const serialized = JSON.stringify(safeErr(nested));

    const { cause } = JSON.parse(serialized).cause;
    expect(cause).toMatchObject({
      code: '23505',
      constraint: 'session_token_unique',
      table: 'session',
      column: 'token',
      routine: '_bt_check_unique',
      name: 'error',
    });
    expect(cause).not.toHaveProperty('detail');
    expect(cause).not.toHaveProperty('where');
    expect(cause).not.toHaveProperty('internalQuery');
    expect(cause).not.toHaveProperty('internalPosition');
    expect(serialized).not.toContain(SESSION_TOKEN);
  });

  it('leaves the original error untouched', () => {
    const cause = uniqueViolation();
    const err = new DrizzleQueryError(FAILED_SQL, [SESSION_TOKEN, EMAIL], cause);
    const { logger } = capturedLogger();

    logger.error({ err, report: false }, 'query failed');

    expect(err.message).toContain(SESSION_TOKEN);
    expect(err.params).toEqual([SESSION_TOKEN, EMAIL]);
    expect(cause.detail).toContain(EMAIL);
  });

  it('serializes an error without bound values as pino does', () => {
    const errors = [
      Object.assign(new TypeError('boom'), { code: 'E_X' }),
      new Error('outer', { cause: Object.assign(new Error('root'), { code: 'E_ROOT' }) }),
      new Error('outer', { cause: { email: EMAIL } }),
      new AggregateError([new Error('inner')], 'many'),
      new DOMException('timed out', 'TimeoutError'),
      Object.assign(new Error('vendor failed'), {
        detail: 'upstream offline',
        query: 'q',
        params: {},
      }),
      { message: 'plain', code: 'E_PLAIN' },
    ];

    for (const err of errors) {
      expect(JSON.stringify(safeErr(err))).toBe(
        JSON.stringify(Reflect.apply(pino.stdSerializers.err, undefined, [err])),
      );
    }
  });

  it('logs and reports an error whose message is a getter', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const { logger, lines } = capturedLogger();
    const err = new DOMException('timed out', 'TimeoutError');

    logger.error({ err }, 'vendor call failed');

    expect(JSON.parse(lines[0] ?? '{}').err).toMatchObject({ message: 'timed out' });
    expect(reporter).toHaveBeenCalledWith(err, expect.anything());
  });

  it('keeps bound values out of the fallback message when none is passed', () => {
    const { logger, lines } = capturedLogger();
    const err = new DrizzleQueryError(FAILED_SQL, [SESSION_TOKEN, EMAIL], uniqueViolation());

    logger.error({ err, report: false });
    logger.error({ err, report: false }, undefined);
    logger.error({ err, report: false, msg: undefined });
    logger.error(err);
    logger.error(err, undefined);

    expect(lines).toHaveLength(5);
    for (const line of lines) {
      expect(line).not.toContain(SESSION_TOKEN);
      expect(JSON.parse(line).msg).toBe(`Failed query: ${FAILED_SQL}`);
    }
  });

  it('logs an error whose message is not a string', () => {
    const { logger, lines } = capturedLogger();
    const err = Object.assign(new Error('x'), { message: 42 });

    expect(() => logger.error({ err, report: false })).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('drops the rejected input from a postgres data exception', () => {
    const pgError = (message: string, code: string) =>
      Object.assign(new DatabaseError(message, 0, 'error'), { code, routine: 'pg_routine' });
    const causes = [
      pgError(`invalid input syntax for type uuid: "${EMAIL}"`, '22P02'),
      pgError(`value "${EMAIL}" is out of range for type integer`, '22003'),
      pgError(`grant ${SESSION_TOKEN} ledger mismatch: balance 120 but entries sum to 80`, 'P0001'),
    ];

    const messages = causes.map((cause) => {
      const serialized = safeErr(new DrizzleQueryError('select 1', [], cause));
      expect(JSON.stringify(serialized)).not.toMatch(/player@|tok_|120/);
      return Reflect.get(Object(serialized), 'message');
    });

    expect(messages).toEqual([
      'Failed query: select 1: invalid input syntax for type uuid',
      'Failed query: select 1: value "?" is out of range for type integer',
      'Failed query: select 1: raised exception (P0001)',
    ]);
  });

  it('keeps a parameter shaped like a stack frame out of the stack', () => {
    const err = new DrizzleQueryError(
      FAILED_SQL,
      [`x\n    at ${SESSION_TOKEN}`],
      uniqueViolation(),
    );

    expect(JSON.stringify(safeErr(err))).not.toContain(SESSION_TOKEN);
  });

  it('scrubs a failed query inside an aggregate error', () => {
    const err = new AggregateError([
      new DrizzleQueryError(FAILED_SQL, [SESSION_TOKEN], uniqueViolation()),
    ]);

    expect(JSON.stringify(safeErr(err))).not.toContain(SESSION_TOKEN);
  });

  it('survives a circular cause chain', () => {
    const loop = new Error('loop');
    const err = new DrizzleQueryError(FAILED_SQL, [SESSION_TOKEN], loop);
    loop.cause = err;

    expect(JSON.stringify(safeErr(err))).not.toContain(SESSION_TOKEN);
  });

  it('redacts fixed sensitive fields', () => {
    const { logger, lines } = capturedLogger();

    logger.info(
      { email: EMAIL, player: { phoneNumber: '+10000000000', id: 'p1' }, playerId: 'p1' },
      'signed in',
    );

    logger.child({ sessionToken: SESSION_TOKEN }).info('child');

    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      email: '[redacted]',
      player: { phoneNumber: '[redacted]', id: 'p1' },
      playerId: 'p1',
    });
    expect(JSON.parse(lines[1] ?? '{}')).toMatchObject({ sessionToken: '[redacted]' });
  });

  it('reports a failed query without its bound values', () => {
    const reporter = vi.fn();
    setErrorReporter(reporter);
    const err = new DrizzleQueryError(FAILED_SQL, [SESSION_TOKEN, EMAIL], uniqueViolation());

    createLogger('test').error(
      { err, original: err, username: 'p', player: { email: EMAIL }, playerId: 'p1' },
      'query failed',
    );

    const [[reported, context]] = reporter.mock.calls;
    expect(reported).toBeInstanceOf(Error);
    expect(reported.message).toBe(`Failed query: ${FAILED_SQL}`);
    expect(reported.cause).toMatchObject({ code: '23505', constraint: 'session_token_unique' });
    expect(context.extra).toMatchObject({
      username: '[redacted]',
      player: { email: '[redacted]' },
      playerId: 'p1',
      message: 'query failed',
    });
    for (const value of [reported, reported.cause, context]) {
      expect(JSON.stringify({ ...value, message: value.message, stack: value.stack })).not.toMatch(
        /tok_|player@/,
      );
    }
  });

  it('reports an error without bound values as it was thrown', () => {
    const err = new TypeError('boom');

    expect(reportableError(err)).toBe(err);
  });
});

describe('activeTraceLogFields', () => {
  it('adds the active span trace and span ids', () => {
    const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
    const spanId = '00f067aa0ba902b7';
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
      trace.wrapSpanContext({ traceId, spanId, traceFlags: TraceFlags.SAMPLED }),
    );

    expect(activeTraceLogFields()).toEqual({ trace_id: traceId, span_id: spanId });
  });

  it('adds nothing outside a span', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(undefined);

    expect(activeTraceLogFields()).toEqual({});
  });

  it('adds nothing for an invalid span context', () => {
    vi.spyOn(trace, 'getActiveSpan').mockReturnValue(
      trace.wrapSpanContext({
        traceId: '0'.repeat(32),
        spanId: '0'.repeat(16),
        traceFlags: TraceFlags.NONE,
      }),
    );

    expect(activeTraceLogFields()).toEqual({});
  });
});
