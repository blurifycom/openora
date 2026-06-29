export function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}
