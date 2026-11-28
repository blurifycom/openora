import { fileURLToPath } from 'node:url';
import { runMigrations } from '@openora/core/server/migrate';

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

export function migrate(databaseUrl?: string) {
  return runMigrations({
    migrationsFolder: fileURLToPath(new URL('./drizzle/migrations', import.meta.url)),
    migrationsTable: '__drizzle_migrations_bonus',
    migrationsSchema: 'drizzle',
    postSql: [...APPEND_ONLY_SQL, ...LEDGER_BALANCE_CHECK_SQL],
    ...(databaseUrl ? { databaseUrl } : {}),
  });
}
