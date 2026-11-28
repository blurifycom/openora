import { customType } from 'drizzle-orm/pg-core';
import type * as z from 'zod';
import { createLogger } from '../kernel/logger.js';

const logger = createLogger('zod-jsonb');

export function zodJsonb<S extends z.ZodType>(
  schema: S,
  columnName: string,
  { severity = 'warn' }: { severity?: 'warn' | 'error' } = {},
) {
  return customType<{ data: z.infer<S>; driverData: string }>({
    dataType: () => 'jsonb',
    toDriver: (value) => JSON.stringify(schema.parse(value)),
    fromDriver: (value) => {
      const parsed = schema.safeParse(value);
      if (parsed.success) {
        return parsed.data;
      }
      const context = { column: columnName, issues: parsed.error.issues.slice(0, 3) };
      const message = 'stored jsonb no longer matches its contract, read as null';
      if (severity === 'error') {
        logger.error({ ...context, err: parsed.error }, message);
      } else {
        logger.warn(context, message);
      }
      return null as z.infer<S>;
    },
  });
}
