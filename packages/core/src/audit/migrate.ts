// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

const APPEND_ONLY_SQL = [
  `CREATE OR REPLACE FUNCTION audit_log_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'audit_log is append-only: % is not permitted', TG_OP;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS audit_log_append_only ON audit_log`,
  `CREATE TRIGGER audit_log_append_only
     BEFORE UPDATE OR DELETE ON audit_log
     FOR EACH STATEMENT EXECUTE FUNCTION audit_log_deny_mutation()`,
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
    postSql: [...APPEND_ONLY_SQL, ...EMAIL_CHANGE_INDEX_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
