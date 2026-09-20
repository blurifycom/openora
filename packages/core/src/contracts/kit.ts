import { z } from 'zod';

export const PageQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(100),
});
export type PageQuery = z.infer<typeof PageQuerySchema>;

export const SortOrderSchema = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrderSchema>;

// Coerces query-string booleans: '?isActive=true' -> true. Shared by module
// contracts so every admin list parses the same way.
export const QueryBooleanSchema = z.preprocess(
  (value) => (value === 'true' ? true : value === 'false' ? false : value),
  z.boolean(),
);

// Coerces a query-string list: '?ids[]=a&ids[]=b' arrives as an array, a bare '?ids=a'
// as a string. Duplicates are dropped so an all-of filter can compare against the count.
export const queryArraySchema = <T extends z.ZodType<string>>(item: T, max: number) =>
  z.preprocess(
    (value) => (value === undefined || Array.isArray(value) ? value : [value]),
    z
      .array(item)
      .min(1)
      .transform((values) => [...new Set(values)])
      .refine((values) => values.length <= max, { message: `at most ${max} distinct values` }),
  );

// kebab-case slug: lowercase alphanum + hyphens, no leading/trailing hyphen.
export const KEBAB_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function createKebabSlugSchema(maxLength: number) {
  return z.string().trim().min(1).max(maxLength).regex(KEBAB_SLUG_PATTERN);
}

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
