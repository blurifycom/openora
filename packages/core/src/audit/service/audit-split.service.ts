// Internal to the audit module (no package subpath): what migrate, audit-copy and the shipper share
// about a main database whose chain moved to its own.

/** The advisory lock every audit migrate of a main database runs under. */
export const AUDIT_MIGRATION_LOCK = 'drizzle.__drizzle_migrations_audit';

/** What `openora-audit-copy --drain-outbox` runs last, under `AUDIT_MIGRATION_LOCK`. */
export const UNMARK_SPLIT_SQL = `COMMENT ON FUNCTION audit_outbox_deny_unshipped_delete() IS NULL`;

// The database a session runs in, whatever route reached it (pooler, socket, TCP, any address):
// its oid and name on the cluster that started at that instant. Two clusters never share a start
// time to the microsecond in practice, and the epoch reads the same in every session time zone.
// Needs no grant beyond what every role has.
export const INSTANCE_SQL = `SELECT current_database() || ':' || d.oid::text || '@'
          || extract(epoch FROM pg_postmaster_start_time())::text AS instance
     FROM pg_database d WHERE d.datname = current_database()`;
