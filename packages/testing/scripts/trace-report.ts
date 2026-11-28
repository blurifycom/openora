import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
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
  signatures: Set<string>;
  seen: Set<string>;
};

type Change = {
  current: ProcedureStats;
  baseline: ProcedureStats | undefined;
  moreQueries: boolean;
  newQueries: boolean;
};

const spanRecord: z.ZodType<SpanRecord> = z.object({
  test: z.string(),
  file: z.string(),
  traceId: z.string(),
  spanId: z.string(),
  parentId: z.string().nullable(),
  name: z.string(),
  startMs: z.number(),
  durationMs: z.number(),
  sql: z.string().exactOptional(),
  pgClient: z.number().exactOptional(),
  httpStatus: z.number().exactOptional(),
});

const parseSpan = (line: string): SpanRecord[] => {
  try {
    const parsed = spanRecord.safeParse(JSON.parse(line));
    return parsed.success ? [parsed.data] : [];
  } catch {
    return [];
  }
};

function readSpans(dir: string): SpanRecord[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .flatMap((file) => readFileSync(join(dir, file), 'utf8').split('\n'))
    .filter(Boolean)
    .flatMap(parseSpan);
}

const HTTP_ROOT = /^[A-Z]+ \//;
const ID_SEGMENT = /\/([0-9a-f]{8}-[0-9a-f-]{27}|\d+)(?=\/|$)/gi;

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

const median = (values: number[]): number => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
};

const signature = (sql: string): string =>
  sql
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\$\d+(, ?\$\d+)*/g, '$')
    .replace(/'[^']*'/g, '?')
    .replace(/\b\d+\b/g, '?')
    .trim();

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

const withoutStatus = (procedure: string): string => procedure.replace(/ \d{3}$/, '');

function withSeenAcrossStatuses(
  baseline: Map<string, ProcedureStats>,
): Map<string, ProcedureStats> {
  const byName = Map.groupBy(baseline.values(), (stat) => withoutStatus(stat.procedure));
  for (const group of byName.values()) {
    const seen = new Set(group.flatMap((stat) => [...stat.seen]));
    for (const stat of group) {
      stat.seen = seen;
    }
  }
  return baseline;
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

function queryLabel(sql: string): string {
  const verb = sql.trim().split(/\s/, 1)[0]?.toUpperCase() ?? '';
  const tables = [
    ...new Set([...sql.matchAll(/\b(?:from|join|into|update)\s+"?(\w+)"?/gi)].map((m) => m[1])),
  ];
  const subject = tables.length > 0 ? tables.join(', ') : (sql.match(/\b(\w+)\(/)?.[1] ?? '');
  return `pg ${verb} ${subject}`.trim();
}

type Row = {
  label: string;
  startMs: number;
  durationMs: number;
  depth: number;
  isNew: boolean;
  kind?: 'lock' | 'write';
};

const LOCK =
  /\bfor\s+(?:no\s+key\s+update|update|key\s+share|share)\b|\bpg_(?:try_)?advisory_(?:xact_)?lock/i;
const WRITE = /^\(?\s*(?:insert|update|delete)\b|\bas\s*\(\s*(?:insert|update|delete)\b/i;
const COMMENTS = /^(?:\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/))*\s*/;
const kindOf = (sql: string): Row['kind'] =>
  LOCK.test(sql) ? 'lock' : WRITE.test(sql.replace(COMMENTS, '')) ? 'write' : undefined;
const TAG = { lock: 'crit, ', write: 'active, ' } as const;

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
  const openTx = new Map<number | undefined, Row>();
  for (const span of pgSpans) {
    const sql = span.sql ?? '';
    if (/^begin\b/i.test(sql.trim())) {
      const row = {
        label: 'pg transaction',
        startMs: span.startMs,
        durationMs: 0,
        depth: 1,
        isNew: false,
      };
      openTx.set(span.pgClient, row);
      out.push(row);
      continue;
    }
    const tx = openTx.get(span.pgClient);
    const inTx = tx !== undefined;
    if (tx && /^(commit|rollback)\b/i.test(sql.trim())) {
      tx.durationMs = span.startMs + span.durationMs - tx.startMs;
      openTx.delete(span.pgClient);
      continue;
    }
    if (TX_CONTROL.test(sql.trim())) {
      continue;
    }
    const isNew = baselineSignatures !== undefined && !baselineSignatures.has(signature(sql));
    const kind = kindOf(sql);
    out.push({
      label: queryLabel(sql),
      startMs: span.startMs,
      durationMs: span.durationMs,
      depth: inTx ? 2 : 1,
      isNew,
      ...(kind ? { kind } : {}),
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

const ganttLabel = (text: string): string =>
  text.replace(/[:#;]/g, ' ').replace(/\s+/g, ' ').trim();

const FOLD_MS = 0.5;
const AXIS_PAD = 0.15;

function ganttRows(all: Row[]): Row[] {
  const inner = all.filter((row) => row.depth > 0).map((row) => ({ ...row, depth: row.depth - 1 }));
  const folds = (row: Row | undefined, like: Row): row is Row =>
    row !== undefined &&
    row.depth === like.depth &&
    row.label === like.label &&
    row.durationMs < FOLD_MS &&
    row.kind === like.kind &&
    !row.isNew;
  const out: Row[] = [];
  for (let index = 0; index < inner.length;) {
    const row = inner[index] as Row;
    let end = index;
    while (folds(inner[end], row)) {
      end += 1;
    }
    const run = end - index >= 2 ? inner.slice(index, end) : [row];
    const last = run.at(-1) as Row;
    out.push(
      run.length === 1
        ? row
        : {
            ...row,
            label: `${row.label} ×${run.length}`,
            durationMs: last.startMs + last.durationMs - row.startMs,
          },
    );
    index += run.length;
  }
  return out;
}

function gantt(request: Request, baselineSignatures: Set<string> | undefined): string {
  const { root } = request;
  const tasks = ganttRows(rows(request, baselineSignatures)).map((row) => {
    const start = Math.max(0, Math.floor(row.startMs - root.startMs));
    const end = Math.max(Math.ceil(row.startMs + row.durationMs - root.startMs), start + 1);
    const name = `${'· '.repeat(row.depth)}${row.isNew ? '+ ' : ''}${ganttLabel(row.label)} ${ms(row.durationMs)}`;
    return `  ${name} :${row.kind ? TAG[row.kind] : ''}${start}, ${end}`;
  });
  return [
    `Trace \`${root.traceId}\` (${request.test}): ${request.queries.length} queries. Red bar: lock, light bar: write${baselineSignatures ? ', `+`: new since the baseline' : ''}.`,
    '',
    '```mermaid',
    'gantt',
    `  title ${ganttLabel(request.procedure)} · ${ms(root.durationMs)}`,
    '  dateFormat x',
    `  axisFormat ${root.durationMs < 1000 ? '%L ms' : '%S.%L s'}`,
    `  section ${ganttLabel(root.name.replace(ID_SEGMENT, '/:id'))}`,
    ...tasks,
    `  end :milestone, ${Math.ceil(root.durationMs * (1 + AXIS_PAD))}, 0ms`,
    '```',
  ].join('\n');
}

export function ganttReport(
  currentDir: string,
  baselineDir: string | undefined,
  match: string,
): string {
  const baselineSpans = baselineDir ? readSpans(baselineDir) : [];
  if (baselineDir && baselineSpans.length === 0) {
    throw new Error(`No spans in the baseline ${baselineDir}: run the suite there first.`);
  }
  const current = stats(toRequests(readSpans(currentDir)));
  const baseline = withSeenAcrossStatuses(stats(toRequests(baselineSpans)));
  const seenByName = new Map(
    [...baseline.values()].map((stat) => [withoutStatus(stat.procedure), stat.seen]),
  );
  const matching = [...current.values()]
    .filter((stat) => withoutStatus(stat.procedure) === match || stat.procedure === match)
    .toSorted((a, b) => a.procedure.localeCompare(b.procedure));
  if (matching.length === 0) {
    return `No recorded request matches "${match}". Run the suite that drives it first.\n`;
  }
  return `${matching
    .flatMap((stat) => {
      const base = baseline.get(stat.procedure);
      const request = typicalRequest(stat, base);
      const seen = baselineDir
        ? (seenByName.get(withoutStatus(stat.procedure)) ?? new Set<string>())
        : undefined;
      return request ? [gantt(request, seen)] : [];
    })
    .join('\n\n')}\n`;
}

const TABLE_HEADER = [
  '| procedure | n | p50 | Δ p50 | queries/req | Δ queries |',
  '|---|--:|--:|--:|--:|--:|',
];

function report(currentDir: string, baselineDir: string | undefined): string {
  const currentSpans = readSpans(currentDir);
  const current = stats(toRequests(currentSpans));
  if (current.size === 0) {
    return '### ⏱ Backend trace\n\nNo procedure spans recorded.\n';
  }
  if (!currentSpans.some((span) => span.name.startsWith('orpc.'))) {
    return "### ⏱ Backend trace\n\n⚠ No oRPC spans: align `@orpc/shared` in packages/testing with core's `@orpc/server`.\n";
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
  const baseline = withSeenAcrossStatuses(stats(toRequests(baselineSpans)));
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

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { gantt: { type: 'string' } },
  });
  const [currentDir, baselineDir] = positionals;
  if (!currentDir) {
    console.error(
      'usage: node scripts/trace-report.ts <trace-results dir> [baseline dir] [--gantt <procedure>]',
    );
    process.exit(1);
  }
  process.stdout.write(
    values.gantt === undefined
      ? report(currentDir, baselineDir)
      : ganttReport(currentDir, baselineDir, values.gantt),
  );
}
