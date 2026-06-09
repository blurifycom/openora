/**
 * assertOwnership - throws `error` when `recordUserId` differs from `expectedUserId`.
 * Pure guard; callers supply the domain error instance.
 */
export function assertOwnership(recordUserId: string, expectedUserId: string, error: Error): void {
  if (recordUserId !== expectedUserId) throw error;
}
