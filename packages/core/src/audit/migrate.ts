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

/** Apply the audit module migrations (idempotent: drizzle skips already-recorded ones). */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_audit',
    migrationsSchema: 'drizzle',
    postSql: APPEND_ONLY_SQL,
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
