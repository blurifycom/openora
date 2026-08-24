import { z } from 'zod';

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderSchema>;

export type PaginationOptions<
  TFilter extends object = object,
  TSortBy extends string = string,
> = PageQuery &
  TFilter & {
    sortBy?: TSortBy;
    sortOrder?: SortOrder;
  };

export type Paginated<T> = { items: T[]; total: number; page: number; limit: number };

export const paginated = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  });
