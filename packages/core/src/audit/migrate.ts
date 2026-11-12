// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

// Every UPDATE, DELETE and TRUNCATE on audit_log raises, for the table owner too. ENABLE ALWAYS
// keeps the triggers firing under `session_replication_role = replica`, which skips ordinary
// triggers, so only DDL (disabling or dropping one) gets past them.
const APPEND_ONLY_SQL = [
  `CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
   END;
   $$`,
  `CREATE OR REPLACE TRIGGER audit_log_append_only
     BEFORE UPDATE OR DELETE ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `CREATE OR REPLACE TRIGGER audit_log_no_truncate
     BEFORE TRUNCATE ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
  `ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_append_only`,
  `ALTER TABLE audit_log ENABLE ALWAYS TRIGGER audit_log_no_truncate`,
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

/** Apply the audit module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_audit',
    migrationsSchema: 'drizzle',
    postSql: [...APPEND_ONLY_SQL, ...CHAIN_UNIQUE_SQL, ...EMAIL_CHANGE_INDEX_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
