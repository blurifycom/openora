#!/usr/bin/env node
/**
 * Back-compat shim. Scaffolding moved to a single Plop-based `turbo gen` engine
 * (one generator catalog + template dir in @oss/turbo-generators, shared with
 * consumer repos). `pnpm scaffold` and the MCP scaffold-* tools both alias to
 * `pnpm gen` -> this just forwards `tsx tools/scaffold.ts <type> ...` there too.
 *
 *   pnpm gen module player tournament      (preferred)
 *   pnpm scaffold module player tournament (alias, still works)
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const result = spawnSync('tsx', ['tools/gen.ts', ...args], { stdio: 'inherit' });
process.exit(result.status ?? 1);
