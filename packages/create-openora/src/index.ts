#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { arch, platform, version as nodeVersion } from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { VERSIONS } from './generated/versions.js';
import {
  buildVars,
  emitTree,
  isTelemetryEnabled,
  parseArgs,
  posix,
  sanitizeName,
} from './render.js';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', 'template');
const TELEMETRY_URL = 'https://telemetry.openora.ai/api/send';
const TELEMETRY_DOCS_URL = 'https://openora.ai/documentation/telemetry';
const UMAMI_WEBSITE_ID = '6c0c7f10-66e1-4100-a9b4-b5640982674d';
const PING_TIMEOUT_MS = 2000;
const CORE_RELEASE = VERSIONS.coreVersion.replace(/^[\^~]/, '');

function die(message: string): never {
  console.error(`\n  error: ${message}\n`);
  process.exit(1);
}

// ponytail: mirrors the payload of packages/core/src/server/runtime/telemetry.ts
// so the scaffolder stays free of the core runtime; change both together.
async function sendScaffoldPing(): Promise<void> {
  await fetch(process.env['OPENORA_TELEMETRY_URL'] ?? TELEMETRY_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': `Mozilla/5.0 (compatible; openora/${CORE_RELEASE})`,
    },
    body: JSON.stringify({
      type: 'event',
      payload: {
        website: UMAMI_WEBSITE_ID,
        hostname: 'instance',
        url: '/scaffold',
        name: 'scaffold',
        id: randomUUID(),
        data: { version: CORE_RELEASE, node: nodeVersion, os: platform, arch },
      },
    }),
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  }).catch(() => undefined);
}

async function main(): Promise<void> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs(process.argv);
  } catch (error) {
    die(error instanceof Error ? error.message : String(error));
  }
  const { target, name: nameFlag, telemetry } = parsed;
  const targetDir = resolve(process.cwd(), target);
  const name = sanitizeName(nameFlag ?? basename(targetDir));

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    die(`${targetDir} already exists and is not empty.`);
  }
  if (!existsSync(templateRoot)) {
    die(`template missing at ${templateRoot}`);
  }

  const vars = buildVars(name, VERSIONS);

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

  if (!isTelemetryEnabled(telemetry, process.env)) {
    return;
  }
  console.log(
    `  Openora counts this run with one anonymous ping. Opt out with --no-telemetry or\n` +
      `  OPENORA_TELEMETRY_DISABLED=1. Details: ${TELEMETRY_DOCS_URL}\n`,
  );
  await sendScaffoldPing();
}

await main();
