// Domain-free leaf primitives (zod only): the shared pagination vocabulary every
// module - in-tree or extracted - links against. Per ADR-0024/0025 it must import
// no domain.
import { z } from 'zod';

// Offset page query, coerced for HTTP GET query strings.
export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(50),
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
