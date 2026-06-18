#!/usr/bin/env node
import { spawnSync } from 'node:child_process';

const [, , generator, ...rest] = process.argv;

if (!generator) {
  console.error('Usage: pnpm gen <generator> [args...]');
  console.error('Generators: module route plugin adapter config event job-worker adr service app');
  console.error('Run `pnpm exec turbo gen` to list them interactively.');
  process.exit(1);
}

const args = ['gen', generator, ...(rest.length > 0 ? ['--args', ...rest] : [])];
const result = spawnSync('turbo', args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
