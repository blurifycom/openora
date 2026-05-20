export function generateTraceId(): string {
  return crypto.randomUUID();
}
