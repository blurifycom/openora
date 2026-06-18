/**
 * Standalone OpenAPI emit (`pnpm regen` -> turbo codegen). Generates
 * docs/openapi.json at the repo root from the contract alone - no server
 * boot, no DB. Keeps the spec fresh so `verify:drift` can catch staleness.
 */
import { generateOpenApiSpec } from '@oss/core/server';
import { buildContract } from './editions.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../../../docs/openapi.json');

// Committed spec advertises only the core surface; gated add-on routes are excluded so the artifact stays edition-stable.
const outPath = await generateOpenApiSpec(buildContract({ includeAddons: false }), {
  info: { title: 'OSS Igaming API', version: '0.0.1' },
  outputPath,
});
process.stdout.write(`OpenAPI spec written to ${outPath}\n`);
