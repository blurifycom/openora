export function assertOwnership(recordUserId: string, expectedUserId: string, error: Error): void {
  if (recordUserId !== expectedUserId) throw error;
}
