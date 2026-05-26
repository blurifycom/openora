import { z } from 'zod';

export const UuidSchema = z.string().uuid();
export const TimestampSchema = z.string().datetime();
export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type Uuid = z.infer<typeof UuidSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;
