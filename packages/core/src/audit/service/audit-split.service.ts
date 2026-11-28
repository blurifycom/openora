export const AUDIT_MIGRATION_LOCK = 'drizzle.__drizzle_migrations_audit';

export const UNMARK_SPLIT_SQL = `COMMENT ON FUNCTION audit_outbox_deny_unshipped_delete() IS NULL`;

export const INSTANCE_SQL = `SELECT current_database() || ':' || d.oid::text || '@'
          || extract(epoch FROM pg_postmaster_start_time())::text AS instance
     FROM pg_database d WHERE d.datname = current_database()`;
