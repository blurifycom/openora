#!/usr/bin/env node
// Standalone runner for prisma-merge. Called by `pnpm regen`.
// Uses mergePrismaPartials from @oss/plugin-host.

import { mergePrismaPartials } from '../packages/platform/plugin-host/src/prisma-merge.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

async function main() {
  await mergePrismaPartials({ repoRoot });
  console.log('prisma-merge: schema.prisma written');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
