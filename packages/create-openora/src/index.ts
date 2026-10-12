#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { arch, platform, version as nodeVersion } from 'node:process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION } from './generated/core-version.js';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', 'template');

const MCP_COMMAND = 'node';
const MCP_ARGS = ['node_modules/@openora/mcp/dist/main.js'];
const SKIPPED_BASENAMES = new Set();
const TELEMETRY_URL = 'https://telemetry.openora.ai/api/send';
const TELEMETRY_DOCS_URL = 'https://openora.ai/documentation/telemetry';
// TODO: swap in the id of the telemetry website once it exists on the collector.
const UMAMI_WEBSITE_ID = '00000000-0000-0000-0000-000000000000';
const PING_TIMEOUT_MS = 2000;
const CORE_RELEASE = CORE_VERSION.replace(/^[\^~]/, '');

type ParsedArgs = {
  target: string;
  name?: string;
  telemetry: boolean;
};

function die(message: string): never {
  console.error(`\n  error: ${message}\n`);
  process.exit(1);
}

const USAGE = 'Usage: npm create @openora <target-dir> [--name <name>] [--no-telemetry]';

function readFlag(args: string[], index: number): { value: string | undefined; next: number } {
  const arg = args[index] ?? '';
  const eq = arg.indexOf('=');
  if (eq !== -1) {
    return { value: arg.slice(eq + 1), next: index };
  }
  return { value: args[index + 1], next: index + 1 };
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let target: string | undefined;
  let name: string | undefined;
  let telemetry = true;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--name' || arg.startsWith('--name=')) {
      const flag = readFlag(args, i);
      name = flag.value;
      i = flag.next;
    } else if (arg === '--no-telemetry') {
      telemetry = false;
    } else if (!arg.startsWith('-') && !target) {
      target = arg;
    }
  }
  if (!target) {
    die(`missing target directory.\n  ${USAGE}`);
  }
  return name === undefined ? { target, telemetry } : { target, name, telemetry };
}

function sanitizeName(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/^-+|-+$/g, '') || 'igaming-app'
  );
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined ? match : value;
  });
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

function undotSegment(segment: string): string {
  return segment.startsWith('__dot__') ? `.${segment.slice('__dot__'.length)}` : segment;
}

function emitTree(srcRoot: string, vars: Record<string, string>, targetDir: string): void {
  for (const file of walk(srcRoot)) {
    if (SKIPPED_BASENAMES.has(basename(file))) {
      continue;
    }

    const rel = relative(srcRoot, file);
    let outRel = rel.split(sep).map(undotSegment).join(sep);
    if (outRel.endsWith('.tpl')) {
      outRel = outRel.slice(0, -'.tpl'.length);
    }

    const raw = readFileSync(file, 'utf8');
    const content = file.endsWith('.tpl') ? substitute(raw, vars) : raw;

    const outPath = join(targetDir, outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
    console.log(`  + ${posix(outRel)}`);
  }
}

function isSet(flag: string | undefined): boolean {
  return flag !== undefined && ['1', 'true', 'yes'].includes(flag.trim().toLowerCase());
}

// ponytail: mirrors the payload and opt-out flags of packages/core/src/server/runtime/telemetry.ts
// so the scaffolder stays free of the core runtime; change both together.
async function sendScaffoldPing(): Promise<void> {
  await fetch(process.env['OPENORA_TELEMETRY_URL'] ?? TELEMETRY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': `openora/${CORE_RELEASE} (node)` },
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
  const { target, name: nameFlag, telemetry } = parseArgs(process.argv);
  const targetDir = resolve(process.cwd(), target);
  const name = sanitizeName(nameFlag ?? basename(targetDir));

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    die(`${targetDir} already exists and is not empty.`);
  }
  if (!existsSync(templateRoot)) {
    die(`template missing at ${templateRoot}`);
  }

  // Operator coordinates the agent files reference. A fresh scaffold gets placeholders;
  // the consumer fills them in once in .rulesync/sync.json and `pnpm sync:agents`
  // re-renders every template-owned file from them.
  const vars: Record<string, string> = {
    name,
    coreVersion: CORE_VERSION,
    mcpCommand: MCP_COMMAND,
    mcpArgsJson: JSON.stringify(MCP_ARGS),
    scope: `@${name}`,
    trackerKey: 'KEY',
    jiraSite: '<your-site>.atlassian.net',
    jiraCloudId: '<your-jira-cloud-id>',
    wikiSpace: '<your-wiki-space>',
    teamChannel: '#<your-team-channel>',
    gitRemotePath: '<group>/<repo>',
    ossDir: '../openora',
    // Only meaningful once the consumer links a local platform checkout; until then the
    // guard-core hook simply never matches.
    ossFromRoot: '../openora',
    mrTarget: 'dev',
  };

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

  const env = process.env;
  if (
    !telemetry ||
    isSet(env['OPENORA_TELEMETRY_DISABLED']) ||
    isSet(env['DO_NOT_TRACK']) ||
    env['CI'] !== undefined ||
    env['NODE_ENV'] === 'test'
  ) {
    return;
  }
  await sendScaffoldPing();
  console.log(
    `  Openora counts this run with one anonymous ping. Opt out with --no-telemetry or\n` +
      `  OPENORA_TELEMETRY_DISABLED=1. Details: ${TELEMETRY_DOCS_URL}\n`,
  );
}

await main();
