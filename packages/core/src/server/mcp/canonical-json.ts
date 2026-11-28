import { createHash } from 'node:crypto';

const MAX_NESTING = 64;

function canonicalJson(value: unknown): string {
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
  if (ancestors.size >= MAX_NESTING) {
    return JSON.stringify('[TooDeep]');
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
