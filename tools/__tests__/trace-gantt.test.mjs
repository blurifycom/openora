// `trace-report.ts --gantt` prints the PR "Trace" section: one mermaid gantt per status of a
// procedure, locks `crit`, writes `active`, statements new since the baseline prefixed `+`.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ganttReport } from '../../packages/testing/scripts/trace-report.ts';

const span = (traceId, spanId, parentId, name, startMs, durationMs, extra = {}) => ({
  test: 'wallet > deposits',
  file: 'wallet.e2e.test.ts',
  traceId,
  spanId,
  parentId,
  name,
  startMs,
  durationMs,
  ...extra,
});

const happy = 'a'.repeat(32);
const refused = 'b'.repeat(32);
const spans = [
  span(happy, '1', null, 'POST /rpc/wallet/deposit', 100, 12, { httpStatus: 200 }),
  span(happy, '2', '1', 'orpc.wallet.deposit', 100.5, 11),
  span(happy, '3', '2', 'pg.query', 101, 1, {
    sql: 'select * from "wallet" where id = $1',
    pgClient: 1,
  }),
  span(happy, '4', '2', 'pg.query', 103, 0.2, { sql: 'begin', pgClient: 1 }),
  span(happy, '5', '2', 'pg.query', 103.4, 2, {
    sql: 'insert into "ledger_entry" values ($1)',
    pgClient: 1,
  }),
  span(happy, '6', '2', 'pg.query', 106, 0.3, { sql: 'commit', pgClient: 1 }),
  span(refused, '7', null, 'POST /rpc/wallet/deposit', 200, 3, { httpStatus: 403 }),
  span(refused, '8', '7', 'orpc.wallet.deposit', 200.2, 2.5),
  span(refused, '9', '8', 'pg.query', 201, 1, {
    sql: 'select * from "wallet" where id = $1',
    pgClient: 2,
  }),
];
const made = [];
after(() => made.forEach((path) => rmSync(path, { recursive: true, force: true })));
const dir = (rows) => {
  const path = mkdtempSync(join(tmpdir(), 'trace-gantt-'));
  made.push(path);
  writeFileSync(join(path, 'spans-0.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'));
  return path;
};

test('prints one gantt per status with the trace id, the transaction as a parent row', () => {
  const out = ganttReport(dir(spans), undefined, 'wallet.deposit');
  assert.match(out, new RegExp(`Trace \`${happy}\` \\(wallet > deposits\\): 2 queries\\.`));
  assert.match(out, new RegExp(`Trace \`${refused}\``));
  assert.equal(out.match(/^gantt$/gm)?.length, 2);
  assert.match(out, /^ {2}title wallet\.deposit 200 · 12 ms$/m);
  assert.match(out, /^ {2}dateFormat x$/m);
  assert.match(out, /^ {2}pg transaction 3\.3 ms :3, 7$/m);
  assert.match(out, /^ {2}· pg INSERT ledger_entry 2\.0 ms :active, 3, 6$/m);
  // The title carries the procedure; no root bar repeats it. A milestone leaves room on the right.
  assert.doesNotMatch(out, /^ {2}wallet\.deposit/m);
  assert.match(out, /^ {2}end :milestone, 14, 0ms$/m);
  assert.doesNotMatch(out, /\+ pg/);
});

test('folds a run of short same-name statements into one row', () => {
  const trace = 'c'.repeat(32);
  const reads = [0, 1, 2].map((n) =>
    span(trace, `r${n}`, '2', 'pg.query', 101 + n * 0.4, 0.3, {
      sql: 'select * from "user" where id = $1',
      pgClient: 3,
    }),
  );
  const out = ganttReport(
    dir([
      span(trace, '1', null, 'POST /rpc/wallet/deposit', 100, 4, { httpStatus: 200 }),
      span(trace, '2', '1', 'orpc.wallet.deposit', 100.2, 3.6),
      ...reads,
      span(trace, 'w', '2', 'pg.query', 102.5, 1, {
        sql: 'select * from "wallet" where id = $1',
        pgClient: 3,
      }),
    ]),
    undefined,
    'wallet.deposit',
  );
  assert.match(out, /^ {2}pg SELECT user ×3 1\.1 ms :1, 3$/m);
  assert.match(out, /^ {2}pg SELECT wallet 1\.0 ms :2, 4$/m);
});

test('marks a statement the baseline never ran, and names a missing procedure', () => {
  const baseline = dir(spans.filter((row) => !row.sql?.startsWith('insert')));
  const out = ganttReport(dir(spans), baseline, 'wallet.deposit');
  assert.match(out, /\+ pg INSERT ledger_entry 2\.0 ms :active, 3, 6$/m);
  assert.match(out, /`\+`: new since the baseline\./);
  assert.match(out, /pg SELECT wallet 1\.0 ms :1, 2$/m);
  assert.match(ganttReport(dir(spans), undefined, 'nope'), /No recorded request matches "nope"/);
});

test('a statement the baseline ran under another status is not new; a bare name matches no other procedure', () => {
  // The baseline ran the insert only in a 403 request, the current run in the 200.
  const baseline = dir([
    ...spans.filter((row) => row.traceId === refused),
    span(refused, '10', '8', 'pg.query', 202, 1, {
      sql: 'insert into "ledger_entry" values ($1)',
      pgClient: 2,
    }),
  ]);
  const out = ganttReport(dir(spans), baseline, 'wallet.deposit');
  assert.doesNotMatch(out, /\+ pg/);
  const other = span('c'.repeat(32), '20', null, 'POST /rpc/wallet/depositLimits', 300, 2, {
    httpStatus: 200,
  });
  const limits = span('c'.repeat(32), '21', '20', 'orpc.wallet.depositLimits', 300.1, 1.8);
  assert.doesNotMatch(
    ganttReport(dir([...spans, other, limits]), undefined, 'wallet.deposit'),
    /depositLimits/,
  );
});

test('refuses an empty baseline instead of marking every statement new', () => {
  assert.throws(
    () => ganttReport(dir(spans), dir([]), 'wallet.deposit'),
    /No spans in the baseline/,
  );
});

test('never folds a locking read into a run of plain reads of the same table', () => {
  const trace = 'd'.repeat(32);
  const read = (id, startMs, sql) =>
    span(trace, id, '2', 'pg.query', startMs, 0.2, { sql, pgClient: 3 });
  const out = ganttReport(
    dir([
      span(trace, '1', null, 'POST /rpc/wallet/deposit', 100, 4, { httpStatus: 200 }),
      span(trace, '2', '1', 'orpc.wallet.deposit', 100.2, 3.6),
      read('a', 100.5, 'select * from "wallet" where id = $1'),
      read('b', 100.8, 'select * from "wallet" where id = $1'),
      read('c', 101.1, 'select * from "wallet" where id = $1 for update'),
    ]),
    undefined,
    'wallet.deposit',
  );
  assert.match(out, /^ {2}pg SELECT wallet ×2 /m);
  assert.match(out, /^ {2}pg SELECT wallet 0\.2 ms :crit, /m);
});
