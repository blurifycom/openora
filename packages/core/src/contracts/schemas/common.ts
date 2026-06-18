import { z } from 'zod';

export const UuidSchema = z.uuid();
export const TimestampSchema = z.iso.datetime();
export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

export type Uuid = z.infer<typeof UuidSchema>;
export type Pagination = z.infer<typeof PaginationSchema>;

export const IdInputSchema = z.object({ id: UuidSchema });
export type IdInput = z.infer<typeof IdInputSchema>;

export const UserIdInputSchema = z.object({ userId: UuidSchema });
export type UserIdInput = z.infer<typeof UserIdInputSchema>;
