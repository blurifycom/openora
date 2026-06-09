/**
 * findOneOrThrow - returns the first element of an already-awaited row array
 * or throws the provided error. Pure function, no Drizzle coupling.
 */
export function findOneOrThrow<T>(rows: T[], error: Error): T {
  const row = rows[0];
  if (row === undefined) throw error;
  return row;
}

/**
 * pageToOffset - converts a 1-based page number + limit into a DB offset.
 */
export function pageToOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}
