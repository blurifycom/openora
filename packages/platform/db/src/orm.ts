// NestJS-free drizzle surface. Modules define tables with these builders, and
// cross-workspace consumers (eg consumer, linked via `link:`) import tables +
// operators from here so they share @oss/db's single physical drizzle-orm copy.
// Importing `drizzle-orm` directly in a linked consumer pulls a second physical
// copy, and drizzle's protected-member classes then fail nominal type checks
// against DrizzleService.db.
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
