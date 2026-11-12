// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

// Every UPDATE, DELETE and TRUNCATE on audit_log raises, whatever the role. ENABLE ALWAYS keeps the
// triggers firing under `session_replication_role = replica`, which skips ordinary triggers, so
// only DDL gets past them: the owner can still disable or drop one, which is why the app must not
// run as the owner (ADR-0052). The function keeps its
// audit_log name from before it guarded the outbox tables too.
const APPEND_ONLY_SQL = [
  `CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger LANGUAGE plpgsql
   SET search_path = pg_catalog, public AS $$
   BEGIN
     RAISE EXCEPTION '% is append-only: % is not permitted', TG_TABLE_NAME, TG_OP;
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
const OUTBOX_GUARD_SQL = [
  `CREATE OR REPLACE FUNCTION audit_outbox_entry_chained(chained_event_id uuid, entry jsonb)
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
   $$`,
  `CREATE OR REPLACE FUNCTION audit_outbox_deny_unshipped_delete() RETURNS trigger
   LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
   BEGIN
     -- Checked apart and first: a rejected entry may not parse, so it never reaches the cast below.
     IF EXISTS (SELECT 1 FROM audit_outbox_rejected WHERE outbox_id = OLD.id AND entry = OLD.entry) THEN
       RETURN OLD;
     END IF;
     IF audit_outbox_entry_chained(OLD.event_id, OLD.entry) THEN
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

/** Apply the audit module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_audit',
    migrationsSchema: 'drizzle',
    postSql: [
      ...APPEND_ONLY_SQL,
      ...OUTBOX_GUARD_SQL,
      ...CHAIN_UNIQUE_SQL,
      ...EMAIL_CHANGE_INDEX_SQL,
    ],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
