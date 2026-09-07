import { customType } from 'drizzle-orm/pg-core';
import type * as z from 'zod';
import { createLogger } from '../kernel/logger.js';

const logger = createLogger('zod-jsonb');

/**
 * A jsonb column whose TypeScript type is inferred from its Zod schema and enforced at
 * both ends of the driver, rather than asserted by `jsonb().$type<T>()`.
 *
 * `$type<T>()` is a cast Postgres never checks, so the column's declared shape and the
 * shape actually stored drift apart silently: rows written by an earlier release outlive
 * the contract that produced them, and the mismatch only surfaces when a route tries to
 * serialize one and fails output validation - taking every other row in that response
 * down with it.
 *
 * Writes parse and throw, because a value the current contract cannot express has no
 * business entering the column - that is where the drift is cheap to fix. Reads degrade
 * to `null` and log, because a row already in the table is a fact: refusing to serve it
 * would trade one unreadable field for a dead endpoint.
 *
 * `severity: 'error'` is for a column whose absence changes a decision rather than a
 * rendering - a compliance signal an operator reads before approving a player. The value
 * still degrades to null, because failing the read would take an admin's whole queue down
 * (and the player's own status page with it, which reads the same row), but the drift is
 * logged at error level and so reaches the bound error tracker instead of sitting in a
 * warn line nobody greps. An empty compliance field must never look like a quiet fact.
 */
export function zodJsonb<S extends z.ZodType>(
  schema: S,
  columnName: string,
  { severity = 'warn' }: { severity?: 'warn' | 'error' } = {},
) {
  return customType<{ data: z.infer<S>; driverData: string }>({
    dataType: () => 'jsonb',
    // Serialized here for the same reason drizzle's own `jsonb` does it: node-postgres
    // stringifies an object parameter as "[object Object]", which Postgres rejects.
    toDriver: (value) => JSON.stringify(schema.parse(value)),
    fromDriver: (value) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        return parsed.data;
      }
      // No row id here - the driver sees the value alone. This says a column has drifted
      // and roughly how; finding the rows is a query, not a log line.
      const context = { column: columnName, issues: parsed.error.issues.slice(0, 3) };
      const message = 'stored jsonb no longer matches its contract, read as null';
      if (severity === 'error') {
        // `err` is what makes createLogger forward this to the error tracker.
        logger.error({ ...context, err: parsed.error }, message);
      } else {
        logger.warn(context, message);
      }
      return null as z.infer<S>;
    },
  });
}
