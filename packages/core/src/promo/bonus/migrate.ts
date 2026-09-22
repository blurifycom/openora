// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

// `onDelete: 'restrict'` on the grant FK only stops a cascading delete of the parent; the
// application role can still UPDATE or DELETE a promo_grant_entry row directly, which breaks
// the immutable ledger and the "sum(entries) = bonusBalance" invariant. Same pattern as the
// audit log: a trigger, not a convention, is the boundary drizzle-kit cannot express.
const APPEND_ONLY_SQL = [
  `CREATE OR REPLACE FUNCTION promo_grant_entry_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'promo_grant_entry is append-only: % is not permitted', TG_OP;
   END;
   $$`,
  `DROP TRIGGER IF EXISTS promo_grant_entry_append_only ON promo_grant_entry`,
  `CREATE TRIGGER promo_grant_entry_append_only
     BEFORE UPDATE OR DELETE ON promo_grant_entry
     FOR EACH STATEMENT EXECUTE FUNCTION promo_grant_entry_deny_mutation()`,
];

/**
 * Apply the bonus module migrations (idempotent: drizzle skips already-recorded ones).
 */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_bonus',
    migrationsSchema: 'drizzle',
    postSql: APPEND_ONLY_SQL,
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
