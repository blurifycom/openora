import { z } from 'zod';

export const UuidSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime();
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
