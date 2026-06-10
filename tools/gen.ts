#!/usr/bin/env node
/**
 * Thin dispatcher giving the clean positional UX over `turbo gen`:
 *
 *   pnpm gen module player tournament
 *   pnpm gen route wallet GET /balance
 *   pnpm gen plugin stripe-payment
 *   pnpm gen adapter stripe-payment PAYMENT_ADAPTER wallet
 *
 * It forwards `<generator> <arg1> <arg2> ...` to `turbo gen <generator> --args ...`,
 * which maps the args to that generator's prompts in order (bypassing them). Run
 * with no args after the generator name to get the interactive prompts instead.
 * The single generator catalog lives in @oss/turbo-generators (one engine, one
 * template dir) and is shared with downstream consumer repos.
 */
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
