// Per ADR-0024/0025 the runtime contract every module links against must import only contracts.
import { z } from 'zod';

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

/** Wrap an item schema in the canonical paginated envelope. */
export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  });
