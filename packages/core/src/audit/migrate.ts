// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool, type PoolClient } from 'pg';
import { runMigrations, withMigrationAdvisoryLock } from '@openora/core/server/migrate';
import { CHAIN_SPLIT_MARK, CHAIN_SPLIT_SQL } from './schema/index.js';

// Every UPDATE, DELETE and TRUNCATE on audit_log raises, whatever the role. ENABLE ALWAYS keeps the
// triggers firing under `session_replication_role = replica`, which skips ordinary triggers, so
// only DDL gets past them: the owner can still disable or drop one, which is why the app must not
// run as the owner (ADR-0053). The function keeps its
// audit_log name from before it guarded the outbox tables too.
const DENY_MUTATION_FN_SQL = `CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger
   LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
   BEGIN
     RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
   END;
   $$`;

const APPEND_ONLY_SQL = [
  DENY_MUTATION_FN_SQL,
  `CREATE OR REPLACE TRIGGER audit_log_append_only
     BEFORE UPDATE OR DELETE ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `CREATE OR REPLACE TRIGGER audit_log_no_truncate
     BEFORE TRUNCATE ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only`,
  `ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate`,
];

// The outbox holds records that are not in the chain yet, so losing a row loses an audit record.
// No UPDATE or TRUNCATE; a DELETE only of a row whose content is kept elsewhere: the same entry
// moved to audit_outbox_rejected under this outbox id, or chained in audit_log under its event id
// with every field the shipper copies equal. Matching the id alone would let a forged row with the
// same id stand in for the real one. The rejected table is append-only like audit_log. Both outbox
// tables come from the engine migration set, which runs before this one.
//
// Every function pins its search_path, so a schema or operator a role puts earlier on its own path
// cannot stand in for the audit tables or the comparisons the guards make.
//
// audit_outbox_entry_chained compares an entry as the shipper writes it: snapshots as jsonb, a
// JSON null or a missing snapshot as SQL NULL, createdAt to the millisecond a JS Date keeps. The
// shipper calls it too, after appending, so a row it would not be allowed to delete moves aside.
//
// With the chain in a database of its own, the outbox's database cannot see audit_log, so the
// guard there takes a delete only from the shipper role (AUDIT_SHIPPER_DATABASE_URL), and only
// while that session holds the shipper lock, which the shipper takes before it reads a batch and
// keeps until it has deleted the batch, after its append committed in the chain's database. The
// lock alone proves nothing, as any role may take an advisory lock; the session's own role is
// what the guard trusts, the shipper role by exact name and not any member of it, so it refuses
// the tables' owner too. Only the shipper role holds DELETE on the outbox and INSERT on the
// rejected table, and migrate refuses it while a member inherits it or may SET it. Weaker than
// the content check still: a shipper whose append failed unseen could delete what never reached
// the chain.
const CHAIN_MATCH_SQL = `CREATE OR REPLACE FUNCTION audit_outbox_entry_chained(chained_event_id uuid, entry jsonb)
   RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $$
     SELECT EXISTS (
       SELECT 1 FROM audit_log l
        WHERE l.event_id = chained_event_id
          AND l.actor_type::text = entry->>'actorType'
          AND l.actor_id IS NOT DISTINCT FROM entry->>'actorId'
          AND l.action = entry->>'action'
          AND l.resource_type = entry->>'resourceType'
          AND l.resource_id IS NOT DISTINCT FROM entry->>'resourceId'
          AND l.before IS NOT DISTINCT FROM nullif(entry->'before', 'null'::jsonb)
          AND l.after IS NOT DISTINCT FROM nullif(entry->'after', 'null'::jsonb)
          AND l.ip IS NOT DISTINCT FROM entry->>'ip'
          AND l.user_agent IS NOT DISTINCT FROM entry->>'userAgent'
          AND l.correlation_id IS NOT DISTINCT FROM entry->>'correlationId'
          AND l.result IS NOT DISTINCT FROM entry->>'result'
          AND l.created_at = date_trunc('milliseconds', (entry->>'createdAt')::timestamptz))
   $$`;

const CHAINED_HERE = `audit_outbox_entry_chained(OLD.event_id, OLD.entry)`;
// The key the shipper locks (audit-shipper.service.ts), as pg_locks shows a bigint advisory key.
const SHIPPER_HOLDS_LOCK = `EXISTS (
       SELECT 1 FROM pg_locks
        WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid() AND objsubid = 1
          AND ((classid::bigint << 32) | objid::bigint) = hashtext('audit_shipper')::bigint)`;

// `deleter`, when given, is checked before anything else: a session that fails it may not delete
// even a row that has shipped.
const outboxGuardSql = (shipped: string, deleter?: string) => [
  `CREATE OR REPLACE FUNCTION audit_outbox_deny_unshipped_delete() RETURNS trigger
   LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
   BEGIN${
     deleter
       ? `
     IF NOT (${deleter}) THEN
       RAISE EXCEPTION 'audit_outbox row % (event %) is the audit shipper''s to delete: DELETE is not permitted',
         OLD.id, OLD.event_id;
     END IF;`
       : ''
   }
     -- Checked apart and first: a rejected entry may not parse, so it never reaches the cast below.
     IF EXISTS (SELECT 1 FROM audit_outbox_rejected WHERE outbox_id = OLD.id AND entry = OLD.entry) THEN
       RETURN OLD;
     END IF;
     IF ${shipped} THEN
       RETURN OLD;
     END IF;
     RAISE EXCEPTION 'audit_outbox row % (event %) is neither chained nor rejected as it is: DELETE is not permitted',
       OLD.id, OLD.event_id;
   END;
   $$`,
  `CREATE OR REPLACE TRIGGER audit_outbox_no_update
     BEFORE UPDATE ON audit_outbox
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `CREATE OR REPLACE TRIGGER audit_outbox_no_truncate
     BEFORE TRUNCATE ON audit_outbox
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `CREATE OR REPLACE TRIGGER audit_outbox_shipped_delete
     BEFORE DELETE ON audit_outbox
     FOR EACH ROW EXECUTE FUNCTION audit_outbox_deny_unshipped_delete()`,
  `CREATE OR REPLACE TRIGGER audit_outbox_rejected_append_only
     BEFORE UPDATE OR DELETE ON audit_outbox_rejected
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `CREATE OR REPLACE TRIGGER audit_outbox_rejected_no_truncate
     BEFORE TRUNCATE ON audit_outbox_rejected
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `ALTER TABLE audit_outbox ENABLE ALWAYS TRIGGER audit_outbox_no_update,
     ENABLE ALWAYS TRIGGER audit_outbox_no_truncate,
     ENABLE ALWAYS TRIGGER audit_outbox_shipped_delete`,
  `ALTER TABLE audit_outbox_rejected ENABLE ALWAYS TRIGGER audit_outbox_rejected_append_only,
     ENABLE ALWAYS TRIGGER audit_outbox_rejected_no_truncate`,
];

// One row per seq, per event and per predecessor: a second writer that slipped past the chain
// lock, or a batch shipped twice, fails its insert instead of forking the chain. prev_hash counts
// NULL as a value, so the chain has one head. Built CONCURRENTLY, like the email indexes below.
// A chain that is already forked cannot take the prev_hash index: migrate stops and names the
// first fork, and the chain has to be verified and repaired by hand before migrating again.
const CHAIN_UNIQUE_SQL = [
  `DO $$
   DECLARE
     invalid text;
     fork record;
   BEGIN
     SELECT string_agg(c.relname, ', ') INTO invalid
       FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname IN ('audit_log_seq_key', 'audit_log_event_id_key', 'audit_log_prev_hash_key')
        AND NOT i.indisvalid;
     IF invalid IS NOT NULL THEN
       RAISE EXCEPTION 'audit_log index % is INVALID from an interrupted build: drop it and migrate again', invalid;
     END IF;
     IF to_regclass('audit_log_seq_key') IS NULL THEN
       SELECT seq, count(*) AS n INTO fork FROM audit_log GROUP BY seq HAVING count(*) > 1
        ORDER BY seq LIMIT 1;
       IF FOUND THEN
         RAISE EXCEPTION 'audit_log has % rows at seq %: run verifyChain and repair the chain before migrating', fork.n, fork.seq;
       END IF;
     END IF;
     IF to_regclass('audit_log_prev_hash_key') IS NULL THEN
       SELECT prev_hash, count(*) AS n, min(seq) AS seq INTO fork FROM audit_log
        GROUP BY prev_hash HAVING count(*) > 1 ORDER BY min(seq) LIMIT 1;
       IF FOUND THEN
         RAISE EXCEPTION 'audit_log hash chain is forked: % rows follow prev_hash %, the first at seq %. Run verifyChain and repair the chain before migrating', fork.n, coalesce(fork.prev_hash, 'NULL (chain head)'), fork.seq;
       END IF;
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS audit_log_seq_key ON audit_log (seq)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS audit_log_event_id_key ON audit_log (event_id)`,
  `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS audit_log_prev_hash_key ON audit_log (prev_hash)
     NULLS NOT DISTINCT`,
];

// The emails an email change names, matched case-insensitively by the support-history lookup,
// partial so the rest of the log does not grow them. Built CONCURRENTLY so a populated audit_log
// keeps taking inserts, those inside business transactions included, while they build. That
// cannot run inside a transaction, as every schema migration does, so they live here and not in
// the schema. An interrupted build leaves an INVALID index that IF NOT EXISTS then skips: drop it
// and migrate again to rebuild it.
const EMAIL_CHANGE_INDEX_SQL = [
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_before_email_idx ON audit_log
     (lower(before->>'email')) WHERE action = 'identity.email.changed'`,
  `CREATE INDEX CONCURRENTLY IF NOT EXISTS audit_log_after_email_idx ON audit_log
     (lower(after->>'email')) WHERE action = 'identity.email.changed'`,
];

const MIGRATIONS = {
  migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
  migrationsTable: '__drizzle_migrations_audit',
  migrationsSchema: 'drizzle',
};

// What the writer role may do in the chain's database: connect, read the chain and append to it.
// No UPDATE, DELETE or TRUNCATE privilege on top of the triggers, and no CREATE anywhere.
const writerGrantsSql = (role: LoginRole) => {
  const database = identifier(role.database, 'AUDIT_DATABASE_URL database');
  return [
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
    `GRANT CONNECT ON DATABASE ${database} TO ${role.quoted}`,
    `REVOKE CREATE ON SCHEMA public FROM PUBLIC`,
    `GRANT USAGE ON SCHEMA public TO ${role.quoted}`,
    `GRANT SELECT, INSERT ON audit_log TO ${role.quoted}`,
    `GRANT USAGE ON SEQUENCE audit_log_seq_seq TO ${role.quoted}`,
  ];
};

// What the shipper role may do in the main database: read the outbox, delete what it shipped, and
// move aside what the chain cannot take. It alone keeps DELETE on the outbox and INSERT on the
// rejected table: they are revoked from PUBLIC and from every other role, the tables' owner
// included (a superuser keeps them whatever its grants). It reads the main database's own audit_log,
// when one is left from before the split, to refuse to start a chain while that one still holds rows.
const shipperGrantsSql = (role: LoginRole) => [
  `GRANT USAGE ON SCHEMA public TO ${role.quoted}`,
  `GRANT SELECT, DELETE ON audit_outbox TO ${role.quoted}`,
  `GRANT SELECT, INSERT ON audit_outbox_rejected TO ${role.quoted}`,
  `GRANT USAGE ON SEQUENCE audit_outbox_rejected_id_seq TO ${role.quoted}`,
  `DO $$
   DECLARE
     target record;
   BEGIN
     IF to_regclass('public.audit_log') IS NOT NULL THEN
       GRANT SELECT ON audit_log TO ${role.quoted};
     END IF;
     REVOKE DELETE ON audit_outbox FROM PUBLIC;
     REVOKE INSERT ON audit_outbox_rejected FROM PUBLIC;
     FOR target IN
       SELECT p.privilege, p.rel::text AS rel, h.holder::regrole::text AS holder
         FROM (VALUES ('audit_outbox'::regclass, 'DELETE'), ('audit_outbox_rejected'::regclass, 'INSERT'))
              AS p(rel, privilege)
         JOIN pg_class c ON c.oid = p.rel
         CROSS JOIN LATERAL (
           SELECT a.grantee AS holder FROM aclexplode(c.relacl) a
            WHERE a.privilege_type = p.privilege AND a.grantee <> 0
           UNION
           SELECT c.relowner) h
        WHERE h.holder <> '${role.name}'::regrole
     LOOP
       EXECUTE format('REVOKE %s ON %s FROM %s', target.privilege, target.rel, target.holder);
     END LOOP;
   END $$`,
];

// The writer role must not reach the main database, and PUBLIC holds CONNECT on every database
// by default, so PUBLIC loses it there, on the first split migrate only: a later run must not undo
// what an operator revoked since. Every role that owns or holds a grant on a table in its public
// schema, the app's own among them, keeps it by name. A role added later that only connects
// (monitoring, backup) needs its own GRANT CONNECT.
const MAIN_CONNECT_SQL = `DO $$
   DECLARE holder text;
   BEGIN
     FOR holder IN
       SELECT a.grantee::regrole::text FROM pg_class c, aclexplode(c.relacl) a
        WHERE c.relnamespace = 'public'::regnamespace AND a.grantee <> 0
       UNION
       SELECT c.relowner::regrole::text FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace
     LOOP
       EXECUTE format('GRANT CONNECT ON DATABASE %I TO %s', current_database(), holder);
     END LOOP;
     EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database());
   END $$`;

// On every run: the writer never connects to the main database, the shipper always may.
const mainConnectByRoleSql = (writer: LoginRole, shipper: LoginRole) => `DO $$
   BEGIN
     EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM ${writer.quoted}', current_database());
     EXECUTE format('GRANT CONNECT ON DATABASE %I TO ${shipper.quoted}', current_database());
   END $$`;

const MARK_SPLIT_SQL = `COMMENT ON FUNCTION audit_outbox_deny_unshipped_delete() IS '${CHAIN_SPLIT_MARK}'`;

// Per audit role. Each replica opens up to AUDIT_DATABASE_POOL_MAX connections as each role, so
// replicas x AUDIT_DATABASE_POOL_MAX must stay within it.
const ROLE_CONNECTION_LIMIT = 20;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
// What CREATE DATABASE raises when a concurrent migrate created it first.
const ALREADY_EXISTS = new Set(['42P04', '23505']);

const ROLE_STATE_SQL = `SELECT r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication
            OR r.rolbypassrls AS privileged,
          EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS grouped,
          -- PG16 makes a CREATEROLE admin that is not a superuser a member of each role it creates,
          -- with ADMIN only: that grant neither inherits nor may SET, so it passes. Before PG16
          -- every membership inherits and may SET (the columns are missing there, hence to_jsonb).
          EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid
                     AND coalesce((to_jsonb(m)->>'inherit_option')::boolean
                                  OR (to_jsonb(m)->>'set_option')::boolean, true)) AS shared
     FROM pg_roles r WHERE r.rolname = $1`;

type LoginRole = { name: string; quoted: string; password: string; database: string };

function identifier(value: string, part: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`${part} '${value}' must match ${IDENTIFIER}`);
  }
  return `"${value}"`;
}

const databaseOf = (url: string) => decodeURIComponent(new URL(url).pathname.slice(1));
const userOf = (url: string) => decodeURIComponent(new URL(url).username);

function loginRole(url: string, env: string): LoginRole {
  const name = userOf(url);
  const password = decodeURIComponent(new URL(url).password);
  if (!password) {
    throw new Error(`${env} must carry the password of its role`);
  }
  return { name, quoted: identifier(name, `${env} user`), password, database: databaseOf(url) };
}

/**
 * Creates `role` as a login with no attribute that reaches past its grants, or takes the existing
 * one when it has none either, belongs to no other role and has no member that inherits it or
 * may SET it, then sets its password and connection limit. ALTER does not restate the attributes:
 * an admin that is not a superuser, as on a managed Postgres, may not name SUPERUSER, CREATEDB,
 * REPLICATION or BYPASSRLS even to turn them off.
 */
async function ensureLoginRole(client: PoolClient, role: LoginRole): Promise<void> {
  await client.query(`DO $$ BEGIN
       CREATE ROLE ${role.quoted} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
     EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
     END $$`);
  const { rows } = await client.query<{ privileged: boolean; grouped: boolean; shared: boolean }>(
    ROLE_STATE_SQL,
    [role.name],
  );
  if (rows[0]?.privileged) {
    throw new Error(
      `audit role ${role.name} holds SUPERUSER, CREATEDB, CREATEROLE, REPLICATION or BYPASSRLS: drop the attribute and migrate again`,
    );
  }
  if (rows[0]?.grouped) {
    throw new Error(
      `audit role ${role.name} is a member of another role: revoke the membership and migrate again`,
    );
  }
  if (rows[0]?.shared) {
    throw new Error(
      `audit role ${role.name} has members that inherit it or may SET it: revoke the membership and migrate again`,
    );
  }
  await client.query(
    `ALTER ROLE ${role.quoted} WITH LOGIN CONNECTION LIMIT ${ROLE_CONNECTION_LIMIT} PASSWORD '${scramVerifier(role.password)}'`,
  );
}

async function inTransaction(client: PoolClient, statements: string[]): Promise<void> {
  await client.query('BEGIN');
  try {
    for (const statement of statements) {
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function isSplit(client: Pool | PoolClient): Promise<boolean> {
  const { rows } = await client.query<{ split: boolean }>(CHAIN_SPLIT_SQL);
  return rows[0]?.split ?? false;
}

/**
 * The SCRAM-SHA-256 verifier Postgres stores for `password`, so ALTER ROLE never carries the
 * password itself. The verifier still reaches a log that records DDL (`log_statement = ddl` or
 * `all`), and it is enough to try passwords against offline, so keep such logs as secret as the
 * password.
 */
function scramVerifier(password: string): string {
  const iterations = 4096;
  const salt = randomBytes(16);
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const hmac = (text: string) => createHmac('sha256', salted).update(text).digest();
  const storedKey = createHash('sha256').update(hmac('Client Key')).digest('base64');
  const serverKey = hmac('Server Key').toString('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

function withDatabase(url: string, database: string): string {
  const next = new URL(url);
  next.pathname = `/${database}`;
  return next.toString();
}

export type AuditMigrateTarget = {
  /** Owner connection to the main database; defaults to DATABASE_ADMIN_URL ?? DATABASE_URL. */
  adminUrl?: string;
  /**
   * The chain's own database as the app reaches it (AUDIT_DATABASE_URL): the database to create,
   * and the login role and password to set up for it. Omitted, the chain stays in the main one.
   */
  auditUrl?: string;
  /**
   * The main database as the shipper reaches it (AUDIT_SHIPPER_DATABASE_URL): the login role and
   * password to set up as the one role that may delete shipped rows from the outbox. Required with
   * `auditUrl`.
   */
  shipperUrl?: string;
};

/**
 * Apply the audit module migrations (idempotent: drizzle skips already-recorded ones). A string is
 * the admin url of a deployment whose chain shares the main database. Refuses a main database
 * whose chain has moved to its own: migrating it as one database would put the content guard back
 * on an outbox that ships elsewhere.
 *
 * With `auditUrl`, the chain gets a database of its own: created when missing, with the url's role
 * as its only other login, which may connect, read the chain and append to it. With `shipperUrl`,
 * the main database gets a login that alone may delete shipped rows from the outbox, and the guard
 * that needs no audit_log beside it. Both roles' passwords and connection limits are set on every
 * run, so rotating a secret is a migrate away. Runs under the audit migration lock on the main
 * database, so concurrent migrates of one deployment take turns.
 */
export async function migrate(target?: string | AuditMigrateTarget): Promise<void> {
  const { adminUrl, auditUrl, shipperUrl } =
    typeof target === 'string' ? { adminUrl: target } : (target ?? {});
  const mainUrl = adminUrl ?? process.env['DATABASE_ADMIN_URL'] ?? process.env['DATABASE_URL'];
  if (!mainUrl) {
    throw new Error('Cannot run migrations: set DATABASE_URL (or DATABASE_ADMIN_URL).');
  }
  if (!auditUrl) {
    const probe = new Pool({ connectionString: mainUrl });
    try {
      if (await isSplit(probe)) {
        throw new Error(
          'the audit chain of this database lives in a database of its own: migrate with auditUrl (AUDIT_DATABASE_URL) and shipperUrl (AUDIT_SHIPPER_DATABASE_URL)',
        );
      }
    } finally {
      await probe.end();
    }
    return runMigrations({
      ...MIGRATIONS,
      postSql: [
        ...APPEND_ONLY_SQL,
        CHAIN_MATCH_SQL,
        ...outboxGuardSql(CHAINED_HERE),
        ...CHAIN_UNIQUE_SQL,
        ...EMAIL_CHANGE_INDEX_SQL,
      ],
      databaseUrl: mainUrl,
    });
  }
  if (!shipperUrl) {
    throw new Error(
      'a chain in its own database needs shipperUrl (AUDIT_SHIPPER_DATABASE_URL): the role that alone deletes shipped outbox rows',
    );
  }
  const writer = loginRole(auditUrl, 'AUDIT_DATABASE_URL');
  const shipper = loginRole(shipperUrl, 'AUDIT_SHIPPER_DATABASE_URL');
  const auditDatabase = identifier(writer.database, 'AUDIT_DATABASE_URL database');
  const mainDatabase = databaseOf(mainUrl);
  if (writer.database === mainDatabase || shipper.database !== mainDatabase) {
    throw new Error(
      `AUDIT_DATABASE_URL must name a database other than the main one '${mainDatabase}', AUDIT_SHIPPER_DATABASE_URL the main one`,
    );
  }
  const mainRoles = new Set([userOf(mainUrl)]);
  const appUrl = process.env['DATABASE_URL'];
  if (appUrl) {
    mainRoles.add(userOf(appUrl));
  }
  if (writer.name === shipper.name || mainRoles.has(writer.name) || mainRoles.has(shipper.name)) {
    throw new Error(
      'AUDIT_DATABASE_URL and AUDIT_SHIPPER_DATABASE_URL each need a role of their own, not the main database admin or app role',
    );
  }

  const admin = new Pool({ connectionString: mainUrl });
  const client = await admin.connect();
  try {
    await withMigrationAdvisoryLock(
      client,
      `${MIGRATIONS.migrationsSchema}.${MIGRATIONS.migrationsTable}`,
      async () => {
        const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
          writer.database,
        ]);
        if (rowCount === 0) {
          await client.query(`CREATE DATABASE ${auditDatabase}`).catch((err: { code?: string }) => {
            if (!ALREADY_EXISTS.has(err.code ?? '')) {
              throw err;
            }
          });
        }
        await ensureLoginRole(client, writer);
        await ensureLoginRole(client, shipper);

        await runMigrations({
          ...MIGRATIONS,
          databaseUrl: withDatabase(mainUrl, writer.database),
          postSql: [
            ...APPEND_ONLY_SQL,
            CHAIN_MATCH_SQL,
            ...CHAIN_UNIQUE_SQL,
            ...EMAIL_CHANGE_INDEX_SQL,
            ...writerGrantsSql(writer),
          ],
        });

        const firstSplit = !(await isSplit(client));
        await inTransaction(client, [
          DENY_MUTATION_FN_SQL,
          ...outboxGuardSql(SHIPPER_HOLDS_LOCK, `session_user = '${shipper.name}'`),
          MARK_SPLIT_SQL,
          ...shipperGrantsSql(shipper),
          ...(firstSplit ? [MAIN_CONNECT_SQL] : []),
          mainConnectByRoleSql(writer, shipper),
        ]);
      },
    );
  } finally {
    client.release();
    await admin.end();
  }
}
