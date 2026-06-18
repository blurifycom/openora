// Consumers must import from here rather than `drizzle-orm` directly to share the same
// physical copy; a second copy causes drizzle's protected-member classes to fail nominal
// type checks against DrizzleService.db.
export * from 'drizzle-orm/pg-core';
export {
  eq,
  ne,
  and,
  or,
  not,
  sql,
  asc,
  desc,
  gt,
  gte,
  lt,
  lte,
  like,
  ilike,
  isNull,
  isNotNull,
  inArray,
  notInArray,
  between,
  count,
  sum,
  avg,
  min,
  max,
} from 'drizzle-orm';
