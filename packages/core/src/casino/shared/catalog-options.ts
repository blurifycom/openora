import * as z from 'zod';
import { JsonSchemaDocumentSchema } from '@openora/core/contracts';

export function paramsJsonSchema(schema: z.ZodType) {
  return JsonSchemaDocumentSchema.parse(
    JSON.parse(JSON.stringify(z.toJSONSchema(schema, { unrepresentable: 'any' }))),
  );
}
