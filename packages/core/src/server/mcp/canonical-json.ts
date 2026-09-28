import { createHash } from 'node:crypto';

/**
 * JSON with object keys sorted at every depth and undefined members dropped, so equal
 * values always produce the same bytes. Total over any input: a bigint serializes as its
 * decimal string and a reference cycle as the string "[Circular]".
 */
export function canonicalJson(value: unknown): string {
  return serialize(value, new Set()) ?? 'null';
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function serialize(value: unknown, ancestors: Set<object>): string | undefined {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') {
    return undefined;
  }
  if (typeof value === 'bigint') {
    return JSON.stringify(value.toString());
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (ancestors.has(value)) {
    return JSON.stringify('[Circular]');
  }
  ancestors.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((item: unknown) => serialize(item, ancestors) ?? 'null').join(',')}]`
    : `{${serializeMembers(value, ancestors).join(',')}}`;
  ancestors.delete(value);
  return serialized;
}

function serializeMembers(value: object, ancestors: Set<object>): string[] {
  return Object.keys(value)
    .sort()
    .flatMap((key) => {
      const member = serialize(Reflect.get(value, key), ancestors);
      return member === undefined ? [] : [`${JSON.stringify(key)}:${member}`];
    });
}
