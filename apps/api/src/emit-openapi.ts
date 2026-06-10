/**
 * Standalone OpenAPI emit (`pnpm regen` -> turbo codegen). Generates
 * docs/openapi.json at the repo root from the contract alone - no server
 * boot, no DB. Keeps the spec fresh so `verify:drift` can catch staleness.
 */
import { generateOpenApiSpec } from '@oss/api-runtime';
import { contract } from '@oss/orpc-contract';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../../../docs/openapi.json');

const outPath = await generateOpenApiSpec(contract, {
  info: { title: 'OSS Igaming API', version: '0.0.1' },
  outputPath,
});
process.stdout.write(`OpenAPI spec written to ${outPath}\n`);
