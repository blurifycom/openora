import { parseArgs } from 'node:util';
import { Client, type Pool } from 'pg';
import { createDrizzleDb, type DrizzleDb } from '@openora/core/server';
import { CHAIN_SPLIT_SQL } from '../schema/index.js';
import { databaseOf, withDatabase } from '../migrate.js';
import { verifyAuditChain, type AuditChainAnchor } from './audit.service.js';
import { drainAuditOutbox } from './audit-shipper.service.js';

const BATCH_SIZE = 1000;
const LOCK_TIMEOUT = '5s';
const MOVED_TRIGGER = 'audit_log_moved';

// The key appendAuditEntries locks under, so a copy batch and an append never interleave.
const CHAIN_LOCK_SQL = `SELECT pg_advisory_xact_lock(hashtext('audit_log'))`;

const COLUMNS_SQL = `SELECT a.attname || ' ' || format_type(a.atttypid, a.atttypmod) AS col
  FROM pg_attribute a
 WHERE a.attrelid = to_regclass('public.audit_log') AND a.attnum > 0 AND NOT a.attisdropped
 ORDER BY a.attnum`;

const DENY_MOVED_SQL = [
  `CREATE OR REPLACE FUNCTION audit_log_deny_moved() RETURNS trigger
     LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
     BEGIN
       RAISE EXCEPTION 'audit_log moved to its own database: % is not permitted here', TG_OP;
     END;
     $$`,
  `CREATE OR REPLACE TRIGGER ${MOVED_TRIGGER}
     BEFORE INSERT ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_moved()`,
  `ALTER TABLE audit_log ENABLE ALWAYS TRIGGER ${MOVED_TRIGGER}`,
];

type Head = { seq: string; hash: string };

export type CopyOptions = { adminUrl: string; auditUrl: string; apply: boolean };
export type DrainOptions = { adminUrl: string; auditUrl: string; shipperUrl?: string };
export type CopyReport = { copied: number; applied: boolean };
export type CopyHooks = { afterCopy?: () => Promise<void> };

class CopyError extends Error {}

const closeDb = (db: DrizzleDb) => (db as DrizzleDb & { $client: Pool }).$client.end();

async function connect(url: string): Promise<Client> {
  const client = new Client({ connectionString: url });
  await client.connect();
  await client.query(`SET TIME ZONE 'UTC'`);
  return client;
}

async function withClients<T>(
  urls: readonly string[],
  fn: (clients: Client[]) => Promise<T>,
): Promise<T> {
  const clients: Client[] = [];
  try {
    for (const url of urls) {
      clients.push(await connect(url));
    }
    return await fn(clients);
  } finally {
    for (const client of clients) {
      await client.end().catch(() => undefined);
    }
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
async function copyStep(source: Client, target: Client, apply: boolean): Promise<number> {
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
  if (apply && copied > 0) {
    await target.query(
      `SELECT setval(pg_get_serial_sequence('audit_log', 'seq'), (SELECT max(seq) FROM audit_log))`,
    );
  }
  return copied;
}

// A dry run is one transaction rolled back at the end, so it never advances the sequence either.
async function copyBatches(source: Client, target: Client, apply: boolean): Promise<number> {
  let total = 0;
  if (!apply) {
    await target.query('BEGIN');
    try {
      for (;;) {
        const copied = await copyStep(source, target, false);
        total += copied;
        if (copied < BATCH_SIZE) {
          return total;
        }
      }
    } finally {
      await target.query('ROLLBACK');
    }
  }
  for (;;) {
    await target.query('BEGIN');
    let copied: number;
    try {
      copied = await copyStep(source, target, true);
      await target.query('COMMIT');
    } catch (err) {
      await target.query('ROLLBACK');
      throw err;
    }
    total += copied;
    if (copied < BATCH_SIZE) {
      return total;
    }
  }
}

async function assertCaughtUp(source: Client, target: Client, complete: boolean): Promise<void> {
  const head = await headOf(target);
  const [{ rows: s }, { rows: t }] = [
    await source.query<{ count: string; head: string | null }>(
      'SELECT count(*) FILTER (WHERE seq <= $1)::text AS count, max(seq)::text AS head FROM audit_log',
      [head?.seq ?? '0'],
    ),
    await target.query<{ count: string }>('SELECT count(*)::text AS count FROM audit_log'),
  ];
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
  const copied = await copyBatches(source, target, apply);
  if (apply) {
    await assertCaughtUp(source, target, complete);
  }
  return {
    copied,
    anchor: before && { fromSeq: Number(before.seq), fromHash: before.hash },
  };
}

async function verifyChainAt(url: string, anchor: AuditChainAnchor | undefined): Promise<void> {
  const db = createDrizzleDb(url);
  try {
    const verdict = await verifyAuditChain(db, anchor);
    if (!verdict.valid) {
      throw new CopyError(`the chain is broken at seq ${verdict.firstBrokenSeq}`);
    }
  } finally {
    await closeDb(db);
  }
}

/**
 * Copies the chain rows the target lacks, in batches of one target transaction each, and checks
 * the target's chain from where it was before the run. Safe to rerun: the target's own head is
 * the cursor. Refuses a target whose head is not the source's row of that seq.
 */
export async function copyChain({ adminUrl, auditUrl, apply }: CopyOptions): Promise<CopyReport> {
  const targetUrl = targetUrlOf(adminUrl, auditUrl);
  const report = await withClients([adminUrl, targetUrl], async ([source, target]) => {
    if (!source || !target) {
      throw new CopyError('could not connect');
    }
    return transfer(source, target, { apply, complete: false });
  });
  if (apply) {
    await verifyChainAt(targetUrl, report.anchor);
  }
  return { copied: report.copied, applied: apply };
}

/**
 * Copies the last of the chain under a lock that stops every writer of the main `audit_log`, and
 * in the same breath installs the trigger that refuses its inserts from then on. The main
 * transaction commits only once the target holds every row, so a crash leaves no fence and no gap.
 */
export async function fenceChain(
  { adminUrl, auditUrl, apply }: CopyOptions,
  hooks: CopyHooks = {},
): Promise<CopyReport> {
  const targetUrl = targetUrlOf(adminUrl, auditUrl);
  const copied = await withClients([adminUrl, targetUrl], async ([main, target]) => {
    if (!main || !target) {
      throw new CopyError('could not connect');
    }
    await main.query('BEGIN');
    try {
      await main.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
      await main.query(CHAIN_LOCK_SQL);
      await main.query('LOCK TABLE audit_log IN EXCLUSIVE MODE');
      const report = await transfer(main, target, { apply, complete: true });
      if (!apply) {
        await main.query('ROLLBACK');
        return report.copied;
      }
      await hooks.afterCopy?.();
      for (const statement of DENY_MOVED_SQL) {
        await main.query(statement);
      }
      await main.query('COMMIT');
      return report.copied;
    } catch (err) {
      await main.query('ROLLBACK').catch(() => undefined);
      throw err;
    }
  });
  if (apply) {
    await verifyChainAt(targetUrl, undefined);
  }
  return { copied, applied: apply };
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

/**
 * Rolls a fenced chain back: lifts the fence and ships the outbox into the main `audit_log`
 * again. Refuses once the audit database holds a row the main one lacks, since a row written after
 * the switch cannot go back.
 */
export async function drainOutboxToLegacy(
  { adminUrl, auditUrl, shipperUrl }: DrainOptions,
  { apply }: { apply: boolean },
): Promise<{ queued: number; applied: boolean }> {
  const targetUrl = targetUrlOf(adminUrl, auditUrl);
  const { split, queued, anchor } = await withClients(
    [adminUrl, targetUrl],
    async ([legacy, target]) => {
      if (!legacy || !target) {
        throw new CopyError('could not connect');
      }
      await assertTargetInLegacy(legacy, target);
      const { rows: marks } = await legacy.query<{ split: boolean }>(CHAIN_SPLIT_SQL);
      const { rows: pending } = await legacy.query<{ queued: string }>(
        'SELECT count(*)::text AS queued FROM audit_outbox',
      );
      const head = await headOf(legacy);
      if (apply) {
        await legacy.query(`DROP TRIGGER IF EXISTS ${MOVED_TRIGGER} ON audit_log`);
      }
      return {
        split: marks[0]?.split ?? false,
        queued: Number(pending[0]?.queued ?? 0),
        anchor: head && { fromSeq: Number(head.seq), fromHash: head.hash },
      };
    },
  );
  if (!apply) {
    return { queued, applied: false };
  }
  if (split && !shipperUrl) {
    throw new CopyError('the main database is split: set AUDIT_SHIPPER_DATABASE_URL');
  }
  const outbox = createDrizzleDb(split ? shipperUrl : adminUrl);
  const legacyChain = createDrizzleDb(adminUrl);
  try {
    await drainAuditOutbox(outbox, legacyChain);
  } finally {
    await Promise.all([closeDb(outbox), closeDb(legacyChain)]);
  }
  await verifyChainAt(adminUrl, anchor);
  return { queued, applied: true };
}

function required(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  if (!value) {
    throw new CopyError(`${key} is required`);
  }
  return value;
}

const write = (stream: NodeJS.WriteStream, line: string) => stream.write(`${line}\n`);

/** The `openora-audit-copy` entry: returns the process exit code. URLs come from `env` only. */
export async function main(
  argv: readonly string[],
  env: Record<string, string | undefined>,
  hooks: CopyHooks = {},
): Promise<number> {
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
    if (values.fence && values['drain-outbox']) {
      throw new CopyError('--fence and --drain-outbox are mutually exclusive');
    }
    const adminUrl = required(env, 'DATABASE_ADMIN_URL');
    const auditUrl = required(env, 'AUDIT_DATABASE_URL');
    const apply = values.apply === true;
    const mode = apply ? 'applied' : 'dry run, nothing written';
    if (values['drain-outbox']) {
      const report = await drainOutboxToLegacy(
        { adminUrl, auditUrl, shipperUrl: env['AUDIT_SHIPPER_DATABASE_URL'] },
        { apply },
      );
      write(process.stdout, `outbox rows queued: ${report.queued} (${mode})`);
      return 0;
    }
    const options = { adminUrl, auditUrl, apply };
    const report = values.fence ? await fenceChain(options, hooks) : await copyChain(options);
    write(
      process.stdout,
      `${values.fence ? 'fenced; ' : ''}rows copied: ${report.copied} (${mode})`,
    );
    return 0;
  } catch (err) {
    write(process.stderr, err instanceof Error ? err.message : 'audit-copy failed');
    return 1;
  }
}
