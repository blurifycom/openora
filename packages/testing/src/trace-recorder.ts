import { appendFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { context, propagation, SpanStatusCode, type Tracer, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { setGlobalOtelConfig } from '@orpc/shared';
import type { Hono } from 'hono';
import pg from 'pg';
import { expect } from 'vitest';

/** One line of `trace-results/spans-<worker>.jsonl`, read by `scripts/trace-report.ts`. */
export type SpanRecord = {
  test: string;
  file: string;
  traceId: string;
  spanId: string;
  parentId: string | null;
  name: string;
  startMs: number;
  durationMs: number;
  sql?: string;
  pgClient?: number;
  httpStatus?: number;
};

const PACKAGE_DIR = join(import.meta.dirname, '..');
export const TRACE_RESULTS_DIR = join(PACKAGE_DIR, 'trace-results');

// Dropped to keep a run's spans small: oRPC's per-request plumbing, queries outside any
// request, a select's column list and the tail of long statements.
const ORPC_PLUMBING = new Set([
  'find_procedure',
  'parse_standard_body',
  'decode_input',
  'validate_input',
  'validate_output',
  'call_procedure',
  'handler',
]);
const MAX_SQL_LENGTH = 400;

const isRecorded = (span: ReadableSpan): boolean =>
  !ORPC_PLUMBING.has(span.name) &&
  !(span.attributes['db.statement'] !== undefined && span.parentSpanContext === undefined);

type Query = (...args: unknown[]) => unknown;
type TraceState = { tracer: Tracer | undefined; patched: boolean };

// pg is loaded once per worker while this setup runs once per test file, so the query
// patch lives on globalThis and is applied once; each file only swaps the tracer it reads.
const STATE_KEY = Symbol.for('openora.testing.trace');
const globals = globalThis as typeof globalThis & { [STATE_KEY]?: TraceState };
const state: TraceState = (globals[STATE_KEY] ??= { tracer: undefined, patched: false });

/**
 * Records a span per HTTP request, per oRPC middleware/handler step (oRPC's own spans) and
 * per pg query into JSONL, so a run can be turned into a per-route waterfall. Test-only:
 * production hosts bring their own OTel SDK and pg instrumentation.
 */
export function recordSpans(): void {
  const file = join(TRACE_RESULTS_DIR, `spans-${process.env['VITEST_POOL_ID'] ?? '0'}.jsonl`);
  mkdirSync(TRACE_RESULTS_DIR, { recursive: true });

  context.disable();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  const provider = new TracerProvider({
    spanProcessors: [new SimpleSpanProcessor({ exporter: jsonlExporter(file) })],
  });
  state.tracer = provider.getTracer('openora-testing');
  setGlobalOtelConfig({ tracer: state.tracer, trace, context, propagation });
  patchPgQuery();
}

type ExportCallback = Parameters<SpanExporter['export']>[1];
// ExportResultCode.SUCCESS, without a direct dependency on @opentelemetry/core for one enum.
const EXPORT_SUCCESS = 0;

function jsonlExporter(file: string): SpanExporter {
  return {
    export(spans: ReadableSpan[], done: ExportCallback): void {
      const { currentTestName, testPath } = expect.getState();
      const lines = spans
        .filter(isRecorded)
        .map((span) => JSON.stringify(toRecord(span, currentTestName, testPath)));
      if (lines.length > 0) {
        appendFileSync(file, `${lines.join('\n')}\n`);
      }
      done({ code: EXPORT_SUCCESS });
    },
    shutdown: () => Promise.resolve(),
  };
}

function toRecord(
  span: ReadableSpan,
  test: string | undefined,
  testPath: string | undefined,
): SpanRecord {
  const sql = span.attributes['db.statement'];
  const pgClient = span.attributes['db.client'];
  const httpStatus = span.attributes['http.response.status_code'];
  return {
    test: test ?? '(setup)',
    file: testPath ? relative(PACKAGE_DIR, testPath) : '',
    traceId: span.spanContext().traceId,
    spanId: span.spanContext().spanId,
    parentId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    startMs: hrToMs(span.startTime),
    durationMs: hrToMs(span.duration),
    ...(typeof sql === 'string' ? { sql: shortenSql(sql) } : {}),
    ...(typeof pgClient === 'number' ? { pgClient } : {}),
    ...(typeof httpStatus === 'number' ? { httpStatus } : {}),
  };
}

const SELECT_LIST = /^(\s*select\s+(?:distinct\s+)?)[^(]*?(\s+from\s+")/i;

/**
 * `select … from "user" where …`: the table and filter fit the cap, so a changed column list
 * no longer reads as a new statement. A list with a subquery or call is kept whole.
 */
const shortenSql = (sql: string): string =>
  sql.replace(SELECT_LIST, '$1…$2').slice(0, MAX_SQL_LENGTH);

const hrToMs = ([seconds, nanos]: [number, number]): number => seconds * 1e3 + nanos / 1e6;

/**
 * Roots each request in a `<METHOD> <path>` span. `app.request()` goes through `fetch`, so
 * this covers every caller, and the Hono middleware before oRPC (session lookup, CORS,
 * rate limits) lands inside the request instead of as stray root spans.
 */
export function traceFetch(app: Hono): void {
  const fetch = app.fetch;
  app.fetch = (request, ...rest) => {
    const tracer = state.tracer;
    if (!tracer) {
      return fetch(request, ...rest);
    }
    const { pathname } = new URL(request.url);
    return tracer.startActiveSpan(`${request.method} ${pathname}`, async (span) => {
      try {
        const response = await fetch(request, ...rest);
        span.setAttribute('http.response.status_code', response.status);
        if (response.status >= 500) {
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        return response;
      } finally {
        span.end();
      }
    });
  };
}

const clientIds = new WeakMap<object, number>();
let nextClientId = 0;

function clientId(client: object): number {
  let id = clientIds.get(client);
  if (id === undefined) {
    id = nextClientId++;
    clientIds.set(client, id);
  }
  return id;
}

/** A span per `Client#query` (pool queries route through it too), ended on result or error. */
function patchPgQuery(): void {
  if (state.patched) {
    return;
  }
  state.patched = true;
  // Library boundary: pg types `query` as a dozen overloads; the patch forwards any of them.
  const proto = pg.Client.prototype as unknown as { query: Query };
  const original = proto.query;
  proto.query = function tracedQuery(this: object, ...args: unknown[]): unknown {
    const sql = sqlText(args[0]);
    if (!state.tracer || sql === undefined) {
      return Reflect.apply(original, this, args);
    }
    const span = state.tracer.startSpan(`pg ${sql.trimStart().split(/\s/, 1)[0]?.toUpperCase()}`, {
      attributes: { 'db.statement': sql, 'db.client': clientId(this) },
    });
    // pg takes the callback last; Pool#query uses that form internally.
    const callback = args.at(-1);
    if (typeof callback === 'function') {
      args[args.length - 1] = (...cbArgs: unknown[]) => {
        span.end();
        return Reflect.apply(callback, this, cbArgs);
      };
      return Reflect.apply(original, this, args);
    }
    const result = Reflect.apply(original, this, args);
    if (result instanceof Promise) {
      return result.finally(() => span.end());
    }
    span.end();
    return result;
  };
  // A pool at capacity queues `connect` callbacks and runs them from whichever request
  // releases a client, which would file the queued request's queries under that one.
  // Library boundary: same for `Pool#connect`'s callback and promise overloads.
  const pool = pg.Pool.prototype as unknown as { connect: Query };
  const connect = pool.connect;
  pool.connect = function boundConnect(this: object, ...args: unknown[]): unknown {
    const callback = args[0];
    if (typeof callback === 'function') {
      args[0] = context.bind(context.active(), callback);
    }
    return Reflect.apply(connect, this, args);
  };
}

function sqlText(query: unknown): string | undefined {
  if (typeof query === 'string') {
    return query;
  }
  if (typeof query === 'object' && query !== null && 'text' in query) {
    return typeof query.text === 'string' ? query.text : undefined;
  }
  return undefined;
}
