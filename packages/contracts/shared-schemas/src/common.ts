import { z } from 'zod';

// The canonical default/public tenant for pre-authentication paths (ADR-0018/0019).
// Requests with no verified user have no tenant context, so anonymous public reads
// (eg the game lobby) and self-registration fall back to this server-side constant.
// It matches the existing 'default' convention (Drizzle tables default tenantId here;
// the seed stamps it as DEMO_TENANT_ID). Multi-brand operators that need a real tenant
// before auth resolve it from host/brand - a documented extension seam, not built here.
export const DEFAULT_TENANT_ID = 'default';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();
export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type Uuid = z.infer<typeof UuidSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;

export const IdInputSchema = z.object({ id: z.string() });
export type IdInput = z.infer<typeof IdInputSchema>;

export const UserIdInputSchema = z.object({ userId: z.string() });
export type UserIdInput = z.infer<typeof UserIdInputSchema>;

// Offset-based pagination (page + limit). Distinct from cursor-based PaginationSchema.
export const PaginationInputSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().positive().max(100).default(20),
});
export type PaginationInput = z.infer<typeof PaginationInputSchema>;
