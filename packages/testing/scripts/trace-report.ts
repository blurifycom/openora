// Turns the spans `src/trace-recorder.ts` wrote into a markdown backend-trace report:
// a table of the procedures that changed against a baseline run (dev) and a waterfall per
// changed procedure, with spans new since the baseline on `+` lines of a diff block.
//
//   node scripts/trace-report.ts <trace-results dir> [baseline trace-results dir]
//
// Without a baseline it lists the procedures with the most queries per request.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SpanRecord } from '../src/trace-recorder.ts';

const BAR_WIDTH = 40;
const NAME_WIDTH = 38;
const MAX_WATERFALLS = 5;
const TOP_WITHOUT_BASELINE = 10;
const COMMON_SQL_SHARE = 0.1;
const TX_CONTROL = /^(begin|commit|rollback|savepoint|release)\b/i;

type Request = {
  procedure: string;
  test: string;
  root: SpanRecord;
  spans: SpanRecord[];
  queries: SpanRecord[];
};

type ProcedureStats = {
  procedure: string;
  requests: Request[];
  p50Ms: number;
  queries: number;
  /** Statements most of its requests run: what a change is judged by. */
  signatures: Set<string>;
  /** Every statement any request ran: what a baseline is checked against. */
  seen: Set<string>;
};

type Change = {
  current: ProcedureStats;
  baseline: ProcedureStats | undefined;
  moreQueries: boolean;
  newQueries: boolean;
};

function readSpans(dir: string): SpanRecord[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n'))
    .filter(Boolean)
    .map((line): SpanRecord => JSON.parse(line));
}

const HTTP_ROOT = /^[A-Z]+ \//;
const ID_SEGMENT = /\/([0-9a-f]{8}-[0-9a-f-]{27}|\d+)(?=\/|$)/gi;

/**
 * A request is a trace rooted at the `<METHOD> <path>` span (or a bare oRPC span for a call
 * that skipped the traced fetch); setup and event-consumer queries have neither. It is keyed
 * by procedure and status, so a rejected call is not averaged into the happy path.
 */
function toRequests(spans: SpanRecord[]): Request[] {
  const byTrace = Map.groupBy(spans, (span) => span.traceId);
  return [...byTrace.values()].flatMap((traceSpans) => {
    const root = traceSpans.find(
      (span) =>
        span.parentId === null && (HTTP_ROOT.test(span.name) || span.name.startsWith('orpc.')),
    );
    if (!root) {
      return [];
    }
    const procedureSpan = traceSpans.find((span) => span.name.startsWith('orpc.'));
    const name = procedureSpan
      ? procedureSpan.name.slice('orpc.'.length)
      : root.name.replace(ID_SEGMENT, '/:id');
    const queries = traceSpans.filter((span) => span.sql && !TX_CONTROL.test(span.sql.trim()));
    const procedure = root.httpStatus ? `${name} ${root.httpStatus}` : name;
    return [{ procedure, test: root.test, root, spans: traceSpans, queries }];
  });
}

/** Upper median: of a 0-query rejection and a 6-query write, the write is the typical one. */
const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

/** Same statement shape regardless of parameter count or literals. */
const signature = (sql: string): string =>
  sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\$\d+(, ?\$\d+)*/g, '$')
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+\b/g, '?')
    .trim();

/**
 * A statement counts as part of a procedure once 1 in 10 of its requests run it. A timer or
 * consumer started inside a request keeps its trace context, so a few unrelated queries leak
 * into busy routes; judged against everything the baseline ever ran, they never read as new.
 */
function signatureCounts(requests: Request[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const request of requests) {
    for (const sig of new Set(request.queries.map((q) => signature(q.sql ?? '')))) {
      counts.set(sig, (counts.get(sig) ?? 0) + 1);
    }
  }
  return counts;
}

function stats(requests: Request[]): Map<string, ProcedureStats> {
  const byProcedure = Map.groupBy(requests, (request) => request.procedure);
  return new Map(
    [...byProcedure].map(([procedure, group]) => [
      procedure,
      {
        procedure,
        requests: group,
        p50Ms: median(group.map((request) => request.root.durationMs)),
        queries: median(group.map((request) => request.queries.length)),
        ...signatureSets(group),
      },
    ]),
  );
}

function signatureSets(requests: Request[]): Pick<ProcedureStats, 'signatures' | 'seen'> {
  const counts = signatureCounts(requests);
  const min = Math.ceil(requests.length * COMMON_SQL_SHARE);
  return {
    signatures: new Set([...counts].filter(([, count]) => count >= min).map(([sig]) => sig)),
    seen: new Set(counts.keys()),
  };
}

function changes(
  current: Map<string, ProcedureStats>,
  baseline: Map<string, ProcedureStats>,
): Change[] {
  return [...current.values()].flatMap((stat) => {
    const base = baseline.get(stat.procedure);
    const moreQueries = base !== undefined && stat.queries > base.queries;
    const newQueries = [...stat.signatures].some((sig) => !base?.seen.has(sig));
    return moreQueries || newQueries
      ? [{ current: stat, baseline: base, moreQueries, newQueries }]
      : [];
  });
}

const ms = (value: number): string => `${value < 10 ? value.toFixed(1) : Math.round(value)} ms`;
const signed = (value: number, unit = ''): string => `${value > 0 ? '+' : ''}${value}${unit}`;

function changeRow({ current, baseline, moreQueries }: Change): string {
  const p50Delta = baseline ? signed(Math.round(current.p50Ms - baseline.p50Ms), ' ms') : 'new';
  const newSql = [...current.signatures].filter((sig) => !baseline?.seen.has(sig)).length;
  const queryDelta = baseline
    ? `${signed(current.queries - baseline.queries)}${moreQueries ? ' ⚠' : ''}${newSql ? `, ${newSql} new SQL` : ''}`
    : 'new';
  return `| \`${current.procedure}\` | ${current.requests.length} | ${ms(current.p50Ms)} | ${p50Delta} | ${current.queries} | ${queryDelta} |`;
}

/** `SELECT wallet, wallet_balance` from the statement's tables, for a row label. */
function queryLabel(sql: string): string {
  const verb = sql.trim().split(/\s/, 1)[0]?.toUpperCase() ?? '';
  const tables = [
    ...new Set([...sql.matchAll(/\b(?:from|join|into|update)\s+"?(\w+)"?/gi)].map((m) => m[1])),
  ];
  // No table (advisory lock, nextval): the call itself is the most telling part.
  const subject = tables.length > 0 ? tables.join(', ') : (sql.match(/\b(\w+)\(/)?.[1] ?? '');
  return `pg ${verb} ${subject}`.trim();
}

type Row = { label: string; startMs: number; durationMs: number; depth: number; isNew: boolean };

/** Root, named middleware and queries; a BEGIN..COMMIT on one connection becomes a parent row. */
function rows(request: Request, baselineSignatures: Set<string> | undefined): Row[] {
  const { root } = request;
  const out: Row[] = [
    {
      label: request.procedure,
      startMs: root.startMs,
      durationMs: root.durationMs,
      depth: 0,
      isNew: false,
    },
  ];
  const middleware = request.spans.filter((span) => /^middleware\.\w/.test(span.name));
  for (const span of middleware) {
    out.push({
      label: span.name,
      startMs: span.startMs,
      durationMs: span.durationMs,
      depth: 1,
      isNew: false,
    });
  }
  const pgSpans = request.spans
    .filter((span) => span.sql)
    .toSorted((a, b) => a.startMs - b.startMs);
  let tx: { client: number | undefined; row: Row } | undefined;
  for (const span of pgSpans) {
    const sql = span.sql ?? '';
    if (/^begin\b/i.test(sql.trim())) {
      tx = {
        client: span.pgClient,
        row: {
          label: 'pg transaction',
          startMs: span.startMs,
          durationMs: 0,
          depth: 1,
          isNew: false,
        },
      };
      out.push(tx.row);
      continue;
    }
    const inTx = tx !== undefined && tx.client === span.pgClient;
    if (tx && inTx && /^(commit|rollback)\b/i.test(sql.trim())) {
      tx.row.durationMs = span.startMs + span.durationMs - tx.row.startMs;
      tx = undefined;
      continue;
    }
    if (TX_CONTROL.test(sql.trim())) {
      continue;
    }
    const isNew = baselineSignatures !== undefined && !baselineSignatures.has(signature(sql));
    out.push({
      label: queryLabel(sql),
      startMs: span.startMs,
      durationMs: span.durationMs,
      depth: inTx ? 2 : 1,
      isNew,
    });
  }
  return out.toSorted((a, b) => (a.depth === 0 ? -1 : b.depth === 0 ? 1 : a.startMs - b.startMs));
}

function waterfall(request: Request, baselineSignatures: Set<string> | undefined): string {
  const { root } = request;
  const scale = BAR_WIDTH / Math.max(root.durationMs, 1);
  const lines = rows(request, baselineSignatures).map((row) => {
    const from = Math.min(BAR_WIDTH - 1, Math.round((row.startMs - root.startMs) * scale));
    const to = Math.min(
      BAR_WIDTH,
      Math.max(from + 1, Math.round((row.startMs + row.durationMs - root.startMs) * scale)),
    );
    const bar = '·'.repeat(from) + '█'.repeat(to - from) + '·'.repeat(BAR_WIDTH - to);
    const label = `${'  '.repeat(row.depth)}${row.label}`;
    const name =
      label.length > NAME_WIDTH ? `${label.slice(0, NAME_WIDTH - 1)}…` : label.padEnd(NAME_WIDTH);
    return `${row.isNew ? '+' : ' '} ${name} ${bar} ${ms(row.durationMs).padStart(7)}`;
  });
  const header = `  ${root.name} · ${request.test}`;
  return [header, ...lines].join('\n');
}

/** A request running a query new since dev if any, else the one at the median duration. */
function typicalRequest(
  stat: ProcedureStats,
  baseline: ProcedureStats | undefined,
): Request | undefined {
  const runsNewQuery = (request: Request) =>
    baseline !== undefined &&
    request.queries.some((q) => {
      const sig = signature(q.sql ?? '');
      return stat.signatures.has(sig) && !baseline.seen.has(sig);
    });
  return (
    stat.requests.find(runsNewQuery) ??
    stat.requests.find((request) => request.root.durationMs === stat.p50Ms)
  );
}

const TABLE_HEADER = [
  '| procedure | n | p50 | Δ p50 | queries/req | Δ queries |',
  '|---|--:|--:|--:|--:|--:|',
];

function report(currentDir: string, baselineDir: string | undefined): string {
  const current = stats(toRequests(readSpans(currentDir)));
  if (current.size === 0) {
    return '### ⏱ Backend trace\n\nNo procedure spans recorded.\n';
  }
  const baselineSpans = baselineDir ? readSpans(baselineDir) : [];
  if (baselineSpans.length === 0) {
    const top = [...current.values()]
      .toSorted((a, b) => b.queries - a.queries)
      .slice(0, TOP_WITHOUT_BASELINE);
    return [
      `### ⏱ Backend trace (no dev baseline, ${current.size} procedures)`,
      '',
      'Most queries per request:',
      '',
      ...TABLE_HEADER,
      ...top.map(
        (stat) =>
          `| \`${stat.procedure}\` | ${stat.requests.length} | ${ms(stat.p50Ms)} | - | ${stat.queries} | - |`,
      ),
      '',
    ].join('\n');
  }
  const baseline = stats(toRequests(baselineSpans));
  const changed = changes(current, baseline).toSorted(
    (a, b) =>
      Number(b.moreQueries) - Number(a.moreQueries) || b.current.queries - a.current.queries,
  );
  if (changed.length === 0) {
    return `### ⏱ Backend trace: 0 changes vs dev (${current.size} procedures)\n`;
  }
  return [
    `### ⏱ Backend trace: ${changed.length} changed vs dev (${current.size} procedures)`,
    '',
    ...TABLE_HEADER,
    ...changed.map(changeRow),
    '',
    '⚠ more queries per request than dev. Δ p50 is informational: run-to-run timing noise is 2x on small procedures. `+` = query new since dev.',
    '',
    ...changed.slice(0, MAX_WATERFALLS).flatMap((change) => {
      const request = typicalRequest(change.current, change.baseline);
      return request
        ? ['```diff', waterfall(request, change.baseline?.seen ?? new Set()), '```']
        : [];
    }),
    '',
  ].join('\n');
}

const [currentDir, baselineDir] = process.argv.slice(2);
if (!currentDir) {
  console.error('usage: node scripts/trace-report.ts <trace-results dir> [baseline dir]');
  process.exit(1);
}
process.stdout.write(report(currentDir, baselineDir));
