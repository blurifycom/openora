// Applies this module's own migration set against its own tracking table, so it
// never collides with sibling modules that share the database. SQL ships in the
// tarball ('files') and loads via an import.meta.url-relative path. See ADR-0020/0027.
import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

// `onDelete: 'restrict'` on the grant FK only stops a cascading delete of the parent; the
// application role can still UPDATE or DELETE a promo_grant_entry row directly, which breaks
// the immutable ledger and the "sum(entries) = bonusBalance" invariant. Same pattern as the
// audit log: a trigger, not a convention, is the boundary drizzle-kit cannot express.
//
// One statement, not three run through separate round trips: `runMigrations` issues each
// `postSql` entry as its own `pool.query`, and a DROP followed later by a CREATE would leave
// the table with no trigger at all in between, a window a concurrent connection could use to
// mutate a ledger row. Postgres runs one multi-command simple-query string as an implicit
// transaction, so the drop and the recreate become atomic and the table is never uncovered.
const APPEND_ONLY_SQL = [
  `CREATE OR REPLACE FUNCTION promo_grant_entry_deny_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
   BEGIN
     RAISE EXCEPTION 'promo_grant_entry is append-only: % is not permitted', TG_OP;
   END;
   $$;
   DROP TRIGGER IF EXISTS promo_grant_entry_append_only ON promo_grant_entry;
   CREATE TRIGGER promo_grant_entry_append_only
     BEFORE UPDATE OR DELETE ON promo_grant_entry
     FOR EACH STATEMENT EXECUTE FUNCTION promo_grant_entry_deny_mutation();`,
];

// The append-only trigger stops a direct mutation of a ledger row, but nothing before this
// stopped a direct UPDATE of promo_grant.bonus_balance itself, which can silently break the
// "sum(entries) = bonus_balance" identity without touching the ledger at all. A deferred
// constraint trigger checks the identity at commit, so a grant creation (one insert, one entry,
// same transaction) still passes, but any commit that leaves the two out of step fails.
const LEDGER_BALANCE_CHECK_SQL = [
  `CREATE OR REPLACE FUNCTION promo_grant_balance_matches_ledger() RETURNS trigger LANGUAGE plpgsql AS $$
   DECLARE
     gid uuid;
     bal numeric;
     total numeric;
   BEGIN
     -- One function bound to both tables: promo_grant_entry rows have no "id" matching the
     -- grant, and promo_grant rows have no "grant_id", so each side's shape decides which
     -- field names the grant, never a field the other table's NEW/OLD does not have.
     IF TG_TABLE_NAME = 'promo_grant_entry' THEN
       gid := COALESCE(NEW.grant_id, OLD.grant_id);
     ELSE
       gid := COALESCE(NEW.id, OLD.id);
     END IF;

     SELECT bonus_balance INTO bal FROM promo_grant WHERE id = gid;
     IF bal IS NULL THEN
       RETURN NULL;
     END IF;
     SELECT COALESCE(SUM(bonus_amount), 0) INTO total FROM promo_grant_entry WHERE grant_id = gid;
     IF total <> bal THEN
       RAISE EXCEPTION 'promo_grant % ledger mismatch: bonus_balance % but entries sum to %',
         gid, bal, total;
     END IF;
     RETURN NULL;
   END;
   $$;
   DROP TRIGGER IF EXISTS promo_grant_entry_balance_matches_ledger ON promo_grant_entry;
   CREATE CONSTRAINT TRIGGER promo_grant_entry_balance_matches_ledger
     AFTER INSERT OR UPDATE OR DELETE ON promo_grant_entry
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION promo_grant_balance_matches_ledger();
   DROP TRIGGER IF EXISTS promo_grant_balance_matches_ledger ON promo_grant;
   CREATE CONSTRAINT TRIGGER promo_grant_balance_matches_ledger
     AFTER UPDATE OF bonus_balance ON promo_grant
     DEFERRABLE INITIALLY DEFERRED
     FOR EACH ROW EXECUTE FUNCTION promo_grant_balance_matches_ledger();`,
];

/**
 * Apply the bonus module migrations (idempotent: drizzle skips already-recorded ones).
 */
export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_bonus',
    migrationsSchema: 'drizzle',
    postSql: [...APPEND_ONLY_SQL, ...LEDGER_BALANCE_CHECK_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
