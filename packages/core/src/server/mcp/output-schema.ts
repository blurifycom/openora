import * as z from 'zod';

export function projectedOutputJsonSchema(
  outputSchema: z.ZodObject,
  keys: readonly string[],
): Record<string, unknown> {
  const keep = new Set(keys);
  const entries = Object.entries(outputSchema.shape).filter(
    (entry): entry is [string, z.core.$ZodType] =>
      keep.has(entry[0]) && entry[1] instanceof z.core.$ZodType,
  );
  return z.toJSONSchema(z.object(Object.fromEntries(entries)), { target: 'draft-7', io: 'output' });
}
