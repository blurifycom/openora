import { describe, it, expect } from 'vitest';
import type * as z from 'zod';
import { domainEventSchemas } from '@openora/core/contracts';
import { auditRecordFor } from '../plugin.js';
import { SUBSCRIBED_TOPICS } from '../contract/subscribed-topics.js';
import { OutboxEntrySchema } from '../service/audit.service.js';

// Leaf values tried in order; a string or number leaf takes the first its own schema accepts.
const STRINGS = [
  '7a1c2f4e-3b5d-4e6f-8a9b-0c1d2e3f4a5b',
  '2026-01-01T00:00:00.000Z',
  '10.00',
  'USD',
  'DE',
  'user@example.com',
  'https://example.com/a',
  '127.0.0.1',
  '2026-01-01',
  'sample_key',
  'a',
];
const NUMBERS = [1, 10, 0, 0.5];
// Set only when the emitter already appended the audit row itself, which skips the mapping.
const SKIPPED_KEYS = new Set(['auditRecorded']);

// The fullest payload a schema accepts: every optional field set, the first variant of a union.
function sample(schema: z.ZodType): unknown {
  const def = schema._zod.def as unknown as Record<string, unknown> & { type: string };
  const inner = (key: string) => sample(def[key] as z.ZodType);
  switch (def.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(def['shape'] as Record<string, z.ZodType>)
          .filter(([key]) => !SKIPPED_KEYS.has(key))
          .map(([key, value]) => [key, sample(value)]),
      );
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
    case 'nonoptional':
      return inner('innerType');
    case 'pipe':
      return inner('in');
    case 'lazy':
      return sample((def['getter'] as () => z.ZodType)());
    case 'array':
      return [inner('element')];
    case 'tuple':
      return (def['items'] as z.ZodType[]).map(sample);
    case 'union':
      return sample((def['options'] as z.ZodType[])[0]!);
    case 'intersection':
      return { ...(inner('left') as object), ...(inner('right') as object) };
    case 'enum':
      return Object.values(def['entries'] as Record<string, unknown>)[0];
    case 'literal':
      return (def['values'] as unknown[])[0];
    case 'record':
      return { [String(inner('keyType'))]: inner('valueType') };
    case 'string':
      return STRINGS.find((value) => schema.safeParse(value).success) ?? 'sample';
    case 'number':
    case 'int':
      return NUMBERS.find((value) => schema.safeParse(value).success) ?? 1;
    case 'boolean':
      return true;
    case 'date':
      return new Date('2026-01-01T00:00:00.000Z');
    case 'null':
      return null;
    default:
      return undefined;
  }
}

describe('audit outbox entry coverage', () => {
  const schemas = domainEventSchemas as Record<string, z.ZodType>;

  it.each(SUBSCRIBED_TOPICS)(
    '%s maps a valid payload to an entry the shipper accepts',
    async (topic) => {
      const schema = schemas[topic];
      expect(schema, `no payload schema for ${topic}`).toBeDefined();
      const payload = schema!.safeParse(sample(schema!));
      expect(payload.error).toBeUndefined();

      const record = await auditRecordFor(topic, payload.data, { correlationId: 'corr-1' });

      expect(record).not.toBeNull();
      const entry = OutboxEntrySchema.safeParse({
        ...record,
        createdAt: new Date().toISOString(),
      });
      expect(entry.error).toBeUndefined();
    },
  );
});
