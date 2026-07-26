#!/usr/bin/env node
/**
 * Emits docs/openapi.json from the assembled contract - no server boot, no DB.
 * Runs via `pnpm regen` and in CI via `pnpm verify:drift`.
 */
import { generateOpenApiSpec } from '@openora/core/server';
import { buildContract } from './build-contract.js';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outputPath = resolve(here, '../../docs/openapi.json');

async function main() {
  const outPath = await generateOpenApiSpec(buildContract(), {
    info: { title: 'OSS Igaming API', version: '0.0.1' },
    outputPath,
  });
  process.stdout.write(`OpenAPI spec written to ${outPath}\n`);
}

main();
