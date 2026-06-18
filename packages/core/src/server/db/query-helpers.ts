export function findOneOrThrow<T>(rows: T[], error: Error): T {
  const row = rows[0];
  if (row === undefined) throw error;
  return row;
}

export function pageToOffset(page: number, limit: number): number {
  return (page - 1) * limit;
}
