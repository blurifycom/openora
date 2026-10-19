#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION } from './generated/core-version.js';
import { buildVars, emitTree, parseArgs, posix, sanitizeName } from './render.js';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', 'template');

function die(message: string): never {
  console.error(`\n  error: ${message}\n`);
  process.exit(1);
}

function main(): void {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  const { target, name: nameFlag } = parsed;
  const targetDir = resolve(process.cwd(), target);
  const name = sanitizeName(nameFlag ?? basename(targetDir));

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    die(`${targetDir} already exists and is not empty.`);
  }
  if (!existsSync(templateRoot)) {
    die(`template missing at ${templateRoot}`);
  }

  const vars = buildVars(name, CORE_VERSION);

  console.log(`\n  Creating ${name} at ${targetDir}`);
  console.log(`  headless api-only consumer (frontend lives in your own repo)`);
  console.log(`  Installs @openora/* from npm - no platform checkout\n`);

  emitTree(templateRoot, vars, targetDir);

  console.log(`
  Done. Next steps:

    cd ${posix(relative(process.cwd(), targetDir)) || '.'}
    pnpm install            # pulls @openora/* from npm + generates agent files
    cp .env.example .env     # then set DATABASE_URL / AUTH_SECRET
    pnpm db:migrate          # apply the schema - runs from node_modules
    pnpm dev                 # api :3001

  Add features with turbo gen:

    pnpm gen plugin          # new overlay plugin
    pnpm gen adapter         # swap a vendor adapter (KYC / payment / notification)

  MCP is preconfigured (.mcp.json -> node_modules/@openora/mcp). Launch Claude
  Code and run /start. This is a headless api - build your frontend in this repo
  and consume the api over HTTP with @openora/core/react.
`);
}

main();
