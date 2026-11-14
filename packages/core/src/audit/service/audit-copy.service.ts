import { parseArgs } from 'node:util';
import { Client, Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { DrizzleDb } from '@openora/core/server';
import { CHAIN_SPLIT_SQL } from '../schema/index.js';
import { databaseOf, withDatabase } from '../migrate.js';
import { verifyAuditChain, type AuditChainAnchor } from './audit.service.js';
import { drainAuditOutbox } from './audit-shipper.service.js';

const BATCH_SIZE = 1000;
const LOCK_TIMEOUT = '5s';
const MOVED_TRIGGER = 'audit_log_moved';
const CLOSED_TRIGGER = 'audit_log_closed';
const DRAIN_SESSION_OPTIONS = '-c lock_timeout=5s -c statement_timeout=60s';
const USAGE = 'usage: openora-audit-copy [--apply] [--fence | --drain-outbox]';

// The chain lock of the database it runs in, the key appendAuditEntries locks under. In the
// target it keeps a live shipper's append out of a copy batch; in the main database it only
// stops a legacy writer that takes it, which is why the fence also locks the table. In a plain
// copy it merely serializes two copy runs.
const CHAIN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('audit_log'))`;

const COLUMNS_SQL = `SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) AS col
  FROM pg_attribute a
 WHERE a.attrelid = to_regclass('public.audit_log') AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY a.attnum`;

const denyInsertSql = (trigger: string, message: string) => [
  `CREATE OR REPLACE FUNCTION ${trigger}_deny() RETURNS trigger
     LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       RAISE EXCEPTION '${message}: % is not permitted here', TG_OP;
     END;
     $$`,
  `CREATE OR REPLACE TRIGGER ${trigger}
     BEFORE INSERT ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION ${trigger}_deny()`,
  `ALTER TABLE audit_log ENABLE ALWAYS TRIGGER ${trigger}`,
];

const DENY_MOVED_SQL = denyInsertSql(MOVED_TRIGGER, 'audit_log moved to its own database');
const DENY_CLOSED_SQL = denyInsertSql(
  CLOSED_TRIGGER,
  'audit_log was drained back into the main database',
);

type Head = { seq: string; hash: string };

type CopyOptions = { adminUrl: string; auditUrl: string; apply: boolean };
type DrainOptions = { adminUrl: string; auditUrl: string; shipperUrl?: string };
type CopyReport = { copied: number; applied: boolean };
export type CopyHooks = {
  afterCopy?: () => Promise<void>;
  duringDrain?: () => Promise<void>;
  afterFenceLift?: () => Promise<void>;
  afterDrain?: () => Promise<void>;
};

class CopyError extends Error {}

const say = (line: string) => process.stdout.write(`${line}\n`);

function newClient(url: string): Client {
  const client = new Client({ connectionString: url, application_name: 'openora-audit-copy' });
  // A killed connection is reported by the query that was running, which is what ends the run.
  client.on('error', () => undefined);
  return client;
}

async function withClients<T>(
  firstUrl: string,
  secondUrl: string,
  fn: (first: Client, second: Client) => Promise<T>,
): Promise<T> {
  const first = newClient(firstUrl);
  const second = newClient(secondUrl);
  try {
    for (const client of [first, second]) {
      await client.connect();
      await client.query(`SET TIME ZONE 'UTC'`);
    }
    return await fn(first, second);
  } finally {
    await first.end().catch(() => undefined);
    await second.end().catch(() => undefined);
  }
}

async function withDb<T>(
  url: string,
  fn: (db: DrizzleDb) => Promise<T>,
  options?: string,
): Promise<T> {
  const pool = new Pool({ connectionString: url, max: 2, options });
  pool.on('error', () => undefined);
  try {
    return await fn(drizzle(pool, { casing: 'snake_case' }));
  } finally {
    await pool.end().catch(() => undefined);
  }
}

// The target is reached as migrate reaches it: the main database's owner credentials on the audit
// database's name, because the owner alone may setval the sequence and create the fence trigger.
function targetUrlOf(adminUrl: string, auditUrl: string): string {
  const database = databaseOf(auditUrl);
  if (database === databaseOf(adminUrl)) {
    throw new CopyError('AUDIT_DATABASE_URL must name a database other than the main one');
  }
  return withDatabase(adminUrl, database);
}

async function headOf(db: Client): Promise<Head | undefined> {
  const { rows } = await db.query<Head>(
    'SELECT seq::text AS seq, hash FROM audit_log ORDER BY audit_log.seq DESC LIMIT 1',
  );
  return rows[0];
}

async function snapshot(label: string, db: Client): Promise<void> {
  const head = await headOf(db);
  const { rows } = await db.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM audit_log',
  );
  say(`${label}: rows=${rows[0]?.count} head=${head ? `${head.seq}:${head.hash}` : 'none'}`);
}

async function isSplit(main: Client): Promise<boolean> {
  const { rows } = await main.query<{ split: boolean }>(CHAIN_SPLIT_SQL);
  return rows[0]?.split ?? false;
}

async function columnsOf(db: Client, side: string): Promise<string[]> {
  const { rows } = await db.query<{ col: string }>(COLUMNS_SQL);
  if (rows.length === 0) {
    throw new CopyError(
      side === 'target'
        ? 'the target has no audit_log: run migrate with AUDIT_DATABASE_URL first'
        : 'the source has no audit_log',
    );
  }
  return rows.map(({ col }) => col);
}

async function assertSameShape(source: Client, target: Client): Promise<void> {
  const [sourceColumns, targetColumns] = [
    await columnsOf(source, 'source'),
    await columnsOf(target, 'target'),
  ];
  if (sourceColumns.join(',') !== targetColumns.join(',')) {
    throw new CopyError('audit_log has different columns in the source and the target');
  }
}

async function assertInSource(source: Client, head: Head): Promise<void> {
  const { rows } = await source.query<{ hash: string }>(
    'SELECT hash FROM audit_log WHERE seq = $1',
    [head.seq],
  );
  if (rows[0]?.hash !== head.hash) {
    throw new CopyError(`target diverged from source at seq ${head.seq}`);
  }
}

// One batch inside the caller's target transaction, cursored by the target's own head. The rows
// travel as JSON text from one server to the other, never parsed here, so they land byte-equal.
async function copyStep(source: Client, target: Client): Promise<number> {
  await target.query(CHAIN_LOCK_SQL);
  const head = await headOf(target);
  if (head) {
    await assertInSource(source, head);
  }
  const { rows } = await source.query<{ batch: string }>(
    `SELECT coalesce(json_agg(t ORDER BY seq), '[]')::text AS batch
       FROM (SELECT * FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT ${BATCH_SIZE}) t`,
    [head?.seq ?? '0'],
  );
  const { rowCount } = await target.query(
    'INSERT INTO audit_log SELECT * FROM json_populate_recordset(null::audit_log, $1::json)',
    [rows[0]?.batch ?? '[]'],
  );
  const copied = rowCount ?? 0;
  if (copied > 0) {
    await target.query(
      `SELECT setval(pg_get_serial_sequence('audit_log', 'seq'), (SELECT max(seq) FROM audit_log))`,
    );
  }
  return copied;
}

async function copyBatches(source: Client, target: Client): Promise<number> {
  let total = 0;
  for (;;) {
    await target.query('BEGIN');
    let copied: number;
    try {
      await target.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      copied = await copyStep(source, target);
      await target.query('COMMIT');
    } catch (err) {
      await target.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
    total += copied;
    if (copied < BATCH_SIZE) {
      return total;
    }
  }
}

// A dry run reads only: the rows the source holds beyond the target's head, once that head is
// known to be the source's own row.
async function pendingCount(source: Client, head: Head | undefined): Promise<number> {
  if (head) {
    await assertInSource(source, head);
  }
  const { rows } = await source.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM audit_log WHERE seq > $1',
    [head?.seq ?? '0'],
  );
  return Number(rows[0]?.count ?? 0);
}

async function assertCaughtUp(source: Client, target: Client, complete: boolean): Promise<void> {
  const head = await headOf(target);
  const { rows: s } = await source.query<{ count: string; head: string | null }>(
    'SELECT count(*) FILTER (WHERE seq <= $1)::text AS count, max(seq)::text AS head FROM audit_log',
    [head?.seq ?? '0'],
  );
  const { rows: t } = await target.query<{ count: string }>(
    'SELECT count(*)::text AS count FROM audit_log',
  );
  if (s[0]?.count !== t[0]?.count) {
    throw new CopyError('the target and the source hold a different number of rows');
  }
  if (complete && (s[0]?.head ?? null) !== (head?.seq ?? null)) {
    throw new CopyError('the target is behind the source after the copy');
  }
}

async function transfer(
  source: Client,
  target: Client,
  { apply, complete }: { apply: boolean; complete: boolean },
): Promise<{ copied: number; anchor: AuditChainAnchor | undefined }> {
  await assertSameShape(source, target);
  const before = await headOf(target);
  const anchor = before && { fromSeq: Number(before.seq), fromHash: before.hash };
  if (!apply) {
    return { copied: await pendingCount(source, before), anchor };
  }
  const copied = await copyBatches(source, target);
  await assertCaughtUp(source, target, complete);
  return { copied, anchor };
}

async function verifyChainAt(
  url: string,
  anchor: AuditChainAnchor | undefined,
  label: string,
): Promise<void> {
  const verdict = await withDb(url, (db) => verifyAuditChain(db, anchor));
  const from = anchor ? `from seq ${anchor.fromSeq}` : 'full chain';
  if (!verdict.valid) {
    say(`verify ${label}: broken at seq ${verdict.firstBrokenSeq} (${from})`);
    throw new CopyError(`the chain is broken at seq ${verdict.firstBrokenSeq}`);
  }
  say(`verify ${label}: valid (${from})`);
}

/**
 * Copies the chain rows the target lacks, in batches of one target transaction each, and checks
 * the target's chain from where it was before the run. Safe to rerun: the target's own head is
 * the cursor. Refuses a target whose head is not the source's row of that seq. Without `apply`
 * it only counts.
 */
async function copyChain({ adminUrl, auditUrl, apply }: CopyOptions): Promise<CopyReport> {
  const targetUrl = targetUrlOf(adminUrl, auditUrl);
  return withClients(adminUrl, targetUrl, async (source, target) => {
    const { copied, anchor } = await transfer(source, target, { apply, complete: false });
    if (apply) {
      await snapshot('source', source);
      await snapshot('target', target);
      await verifyChainAt(targetUrl, anchor, 'target');
    }
    return { copied, applied: apply };
  });
}

/**
 * Copies the last of the chain under a lock that stops every writer of the main `audit_log`, and
 * in the same breath installs the trigger that refuses its inserts from then on. The main
 * transaction commits only once the target holds every row and its whole chain verifies, so a
 * failure leaves no fence and no gap. The target's chain is verified in full before the lock is
 * taken; under it only the rows after that point are, so run an unfenced copy first to keep the
 * window short. Needs a
 * main database that split `migrate` has marked. Without `apply` it takes no lock and only counts.
 */
async function fenceChain(
  { adminUrl, auditUrl, apply }: CopyOptions,
  hooks: CopyHooks = {},
): Promise<CopyReport> {
  const targetUrl = targetUrlOf(adminUrl, auditUrl);
  return withClients(adminUrl, targetUrl, async (main, target) => {
    if (!(await isSplit(main))) {
      throw new CopyError(
        'the main database is not split: run migrate with AUDIT_DATABASE_URL and AUDIT_SHIPPER_DATABASE_URL first',
      );
    }
    if (!apply) {
      const { copied } = await transfer(main, target, { apply: false, complete: true });
      return { copied, applied: false };
    }
    const before = await headOf(target);
    const anchor = before && { fromSeq: Number(before.seq), fromHash: before.hash };
    await verifyChainAt(targetUrl, undefined, 'target before lock');
    await main.query('BEGIN');
    try {
      await main.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await main.query(CHAIN_LOCK_SQL);
      await main.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
      const { copied } = await transfer(main, target, { apply: true, complete: true });
      await hooks.afterCopy?.();
      await snapshot('source', main);
      await snapshot('target', target);
      await verifyChainAt(targetUrl, anchor, 'target');
      for (const statement of DENY_MOVED_SQL) {
        await main.query(statement);
      }
      await main.query('COMMIT');
      return { copied, applied: true };
    } catch (err) {
      await main.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
}

async function assertTargetInLegacy(legacy: Client, target: Client): Promise<void> {
  let cursor = '0';
  for (;;) {
    const { rows } = await target.query<{ batch: string; last: string | null }>(
      `SELECT coalesce(json_agg(json_build_object('seq', seq, 'hash', hash) ORDER BY seq), '[]')::text AS batch,
              max(seq)::text AS last
         FROM (SELECT seq, hash FROM audit_log WHERE seq > $1 ORDER BY seq LIMIT ${BATCH_SIZE}) t`,
      [cursor],
    );
    const last = rows[0]?.last;
    if (!last) {
      return;
    }
    const { rows: matched } = await legacy.query<{ matched: string; total: string }>(
      `SELECT count(l.seq)::text AS matched, json_array_length($1::json)::text AS total
         FROM json_to_recordset($1::json) AS r(seq bigint, hash text)
         LEFT JOIN audit_log l ON l.seq = r.seq AND l.hash = r.hash`,
      [rows[0]?.batch],
    );
    if (matched[0]?.matched !== matched[0]?.total) {
      throw new CopyError(
        'the audit database holds rows the main one lacks: after the switch, roll forward only',
      );
    }
    cursor = last;
  }
}

async function assertShipperIdle(main: Client): Promise<void> {
  await main.query('BEGIN');
  try {
    const { rows } = await main.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_xact_lock(hashtext('audit_shipper')) AS locked`,
    );
    if (!rows[0]?.locked) {
      throw new CopyError('a shipper holds the shipper lock: stop every shipper and writer first');
    }
  } finally {
    await main.query('ROLLBACK').catch(() => undefined);
  }
}

async function liftFence(main: Client): Promise<void> {
  await main.query('BEGIN');
  try {
    await main.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await main.query(`DROP TRIGGER IF EXISTS ${MOVED_TRIGGER} ON audit_log`);
    await main.query('COMMIT');
  } catch (err) {
    await main.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

// Closes the audit database to inserts in a transaction of its own, short enough that nothing waits
// on it for long. The rows it holds are checked under the lock, so what the trigger then freezes is
// known to be in the main database.
async function closeTarget(legacy: Client, target: Client): Promise<void> {
  await target.query('BEGIN');
  try {
    await target.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await target.query(CHAIN_LOCK_SQL);
    await target.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
    await assertTargetInLegacy(legacy, target);
    for (const statement of DENY_CLOSED_SQL) {
      await target.query(statement);
    }
    await target.query('COMMIT');
  } catch (err) {
    await target.query('ROLLBACK').catch(() => undefined);
    throw err;
  }
}

async function assertOutboxEmpty(main: Client): Promise<void> {
  const { rows } = await main.query<{ queued: string }>(
    'SELECT count(*)::text AS queued FROM audit_outbox',
  );
  if (rows[0]?.queued !== '0') {
    throw new CopyError('audit_outbox still holds rows: a writer was not stopped, rerun the drain');
  }
}

async function rejectedCount(main: Client): Promise<number> {
  const { rows } = await main.query<{ rejected: string }>(
    'SELECT count(*)::text AS rejected FROM audit_outbox_rejected',
  );
  return Number(rows[0]?.rejected ?? 0);
}

/**
 * Rolls a fenced chain back. Every refusal (a split main without a shipper url, a shipper holding
 * its lock, a row the main database lacks) comes before anything changes. Then the audit
 * database is closed to inserts by a trigger committed in a short transaction of its own, so a
 * shipper that starts later fails on its insert and keeps its batch in the outbox. Only then is the
 * main fence lifted and the outbox shipped into the main `audit_log`, which must end empty, and
 * every audit row is checked against the main database once more. Every writer must be stopped. A
 * failure at any point leaves the run safe to repeat: the audit database stays closed and a
 * rerun finds it so. Opening it again is a deliberate owner step: `DROP TRIGGER audit_log_closed
 * ON audit_log`.
 */
async function drainOutboxToLegacy(
  { adminUrl, auditUrl, shipperUrl }: DrainOptions,
  { apply }: { apply: boolean },
  hooks: CopyHooks = {},
): Promise<{ queued: number; applied: boolean }> {
  const targetUrl = targetUrlOf(adminUrl, auditUrl);
  return withClients(adminUrl, targetUrl, async (legacy, target) => {
    const outboxUrl = (await isSplit(legacy)) ? shipperUrl : adminUrl;
    if (!outboxUrl) {
      throw new CopyError('the main database is split: set AUDIT_SHIPPER_DATABASE_URL');
    }
    const { rows } = await legacy.query<{ queued: string }>(
      'SELECT count(*)::text AS queued FROM audit_outbox',
    );
    const queued = Number(rows[0]?.queued ?? 0);
    if (!apply) {
      await assertTargetInLegacy(legacy, target);
      return { queued, applied: false };
    }
    await assertShipperIdle(legacy);
    await closeTarget(legacy, target);
    const rejectedBefore = await rejectedCount(legacy);
    await hooks.duringDrain?.();
    const head = await headOf(legacy);
    const anchor = head && { fromSeq: Number(head.seq), fromHash: head.hash };
    await liftFence(legacy);
    await hooks.afterFenceLift?.();
    await withDb(
      outboxUrl,
      (outbox) =>
        withDb(adminUrl, (chain) => drainAuditOutbox(outbox, chain), DRAIN_SESSION_OPTIONS),
      DRAIN_SESSION_OPTIONS,
    );
    await hooks.afterDrain?.();
    await assertOutboxEmpty(legacy);
    const rejectedNow = await rejectedCount(legacy);
    if (rejectedNow > rejectedBefore) {
      throw new CopyError(
        `${rejectedNow - rejectedBefore} outbox rows rejected during drain; inspect audit_outbox_rejected`,
      );
    }
    await assertTargetInLegacy(legacy, target);
    await snapshot('main', legacy);
    await snapshot('audit', target);
    await verifyChainAt(adminUrl, anchor, 'main');
    return { queued, applied: true };
  });
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new CopyError(`${key} is required`);
  }
  return value;
}

type Flags = { apply: boolean; fence: boolean; drain: boolean };

// A parse error's own message can echo an argument, which may be a URL with a password.
function parseFlags(argv: readonly string[]): Flags {
  try {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        apply: { type: 'boolean' },
        fence: { type: 'boolean' },
        'drain-outbox': { type: 'boolean' },
      },
      strict: true,
    });
    return {
      apply: values.apply === true,
      fence: values.fence === true,
      drain: values['drain-outbox'] === true,
    };
  } catch {
    throw new CopyError(USAGE);
  }
}

/**
 * The `openora-audit-copy` entry: returns the process exit code. URLs come from `env` only.
 * `hooks` is a seam for tests, not for callers.
 */
export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  hooks: CopyHooks = {},
): Promise<number> {
  try {
    const { apply, fence, drain } = parseFlags(argv);
    if (fence && drain) {
      throw new CopyError(`--fence and --drain-outbox are mutually exclusive\n${USAGE}`);
    }
    const adminUrl = required(env, 'DATABASE_ADMIN_URL');
    const auditUrl = required(env, 'AUDIT_DATABASE_URL');
    const mode = apply ? 'applied' : 'dry run, nothing written';
    if (drain) {
      const report = await drainOutboxToLegacy(
        { adminUrl, auditUrl, shipperUrl: env['AUDIT_SHIPPER_DATABASE_URL'] },
        { apply },
        hooks,
      );
      say(`outbox rows queued: ${report.queued} (${mode})`);
      return 0;
    }
    const options = { adminUrl, auditUrl, apply };
    const report = fence ? await fenceChain(options, hooks) : await copyChain(options);
    say(
      `${fence ? 'fence: ' : ''}rows ${apply ? 'copied' : 'to copy'}: ${report.copied} (${mode})`,
    );
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : 'audit-copy failed'}\n`);
    return 1;
  }
}
