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
 */
export function zodJsonb<S extends z.ZodType>(schema: S, columnName: string) {
  return customType<{ data: z.infer<S>; driverData: unknown }>({
    dataType: () => 'jsonb',
    toDriver: (value) => schema.parse(value),
    fromDriver: (value) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        return parsed.data;
      }
      // No row id here - the driver sees the value alone. This says a column has drifted
      // and roughly how; finding the rows is a query, not a log line.
      logger.warn(
        { column: columnName, issues: parsed.error.issues.slice(0, 3) },
        'stored jsonb no longer matches its contract, read as null',
      );
      return null as z.infer<S>;
    },
  });
}
