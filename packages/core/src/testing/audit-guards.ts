import { sql } from 'drizzle-orm';
import type { DrizzleDb, DrizzleTx } from '@openora/core/server';

// The append-only triggers the audit migration puts on the audit tables, all ENABLE ALWAYS.
const AUDIT_GUARD_TRIGGERS = {
  audit_log: ['audit_log_append_only', 'audit_log_no_truncate'],
  audit_outbox: [
    'audit_outbox_no_update',
    'audit_outbox_no_truncate',
    'audit_outbox_shipped_delete',
  ],
  audit_outbox_rejected: ['audit_outbox_rejected_append_only', 'audit_outbox_rejected_no_truncate'],
} as const;

function alterTriggers(action: 'DISABLE' | 'ENABLE ALWAYS') {
  return Object.entries(AUDIT_GUARD_TRIGGERS).map(([table, triggers]) =>
    sql.raw(
      `ALTER TABLE ${table} ${triggers.map((name) => `${action} TRIGGER ${name}`).join(', ')}`,
    ),
  );
}

/**
 * Runs `mutate` with the audit tables' append-only triggers off, for a test reset or a tamper
 * fixture. One transaction lifts and restores them, so a failure cannot leave them off; `mutate`
 * must write through `tx`, since the lift locks the tables against every other connection.
 */
export function withAuditGuardsLifted<T>(
  db: DrizzleDb,
  mutate: (tx: DrizzleTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    for (const statement of alterTriggers('DISABLE')) {
      await tx.execute(statement);
    }
    const result = await mutate(tx);
    for (const statement of alterTriggers('ENABLE ALWAYS')) {
      await tx.execute(statement);
    }
    return result;
  });
}
