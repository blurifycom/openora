import { OpenAPIGenerator } from '@orpc/openapi';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import type { ContractRouter } from '@orpc/contract';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export type GenerateOpenApiSpecOptions = {
  info?: { title?: string; version?: string };
  outputPath: string;
};

/**
 * Generate the OpenAPI spec from a contract and write it to disk.
 * Pure codegen - no server boot, no DB. Used by the standalone `codegen` script (`pnpm regen`).
 */
export async function generateOpenApiSpec(
  // oxlint-disable-next-line typescript/no-explicit-any
  contract: ContractRouter<any>,
  options: GenerateOpenApiSpecOptions,
): Promise<string> {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  const spec = await generator.generate(contract, {
    info: {
      title: options.info?.title ?? 'OSS Igaming API',
      version: options.info?.version ?? '0.0.1',
    },
  });
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, JSON.stringify(spec, null, 2) + '\n', 'utf8');
  return options.outputPath;
}
