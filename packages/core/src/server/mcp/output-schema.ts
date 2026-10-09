import * as z from 'zod';

/**
 * The JSON Schema of a tool's output once only `keys` remain. Clients validate structured
 * output against it, so it must not require a key the kernel strips. zod's `.pick()` would
 * do this, but it throws on an object schema that carries refinements.
 */
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
