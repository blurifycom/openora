// `trace-report.ts --gantt` prints the PR "Trace" section: one mermaid gantt per status of a
// procedure, statements new since the baseline marked `crit`.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
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
const dir = (rows) => {
  const path = mkdtempSync(join(tmpdir(), 'trace-gantt-'));
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
  assert.match(out, /^ {2}· pg transaction 3\.3 ms :3, 7$/m);
  assert.match(out, /^ {2}· · pg INSERT ledger_entry 2\.0 ms :3, 6$/m);
  assert.doesNotMatch(out, /crit/);
});

test('marks a statement the baseline never ran, and names a missing procedure', () => {
  const baseline = dir(spans.filter((row) => !row.sql?.startsWith('insert')));
  const out = ganttReport(dir(spans), baseline, 'wallet.deposit');
  assert.match(out, /pg INSERT ledger_entry 2\.0 ms :crit, 3, 6$/m);
  assert.match(out, /pg SELECT wallet 1\.0 ms :1, 2$/m);
  assert.match(ganttReport(dir(spans), undefined, 'nope'), /No recorded request matches "nope"/);
});
