#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CORE_VERSION } from './generated/core-version.js';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', 'template');

const MCP_COMMAND = 'node';
const MCP_ARGS = ['node_modules/@openora/mcp/dist/main.js'];
const SKIPPED_BASENAMES = new Set();

type ParsedArgs = {
  target: string;
  name?: string;
};

function die(message: string): never {
  console.error(`\n  error: ${message}\n`);
  process.exit(1);
}

const USAGE = 'Usage: npm create @openora <target-dir> [--name <name>]';

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
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === '--name' || arg.startsWith('--name=')) {
      const flag = readFlag(args, i);
      name = flag.value;
      i = flag.next;
    } else if (!arg.startsWith('-') && !target) {
      target = arg;
    }
  }
  if (!target) {
    die(`missing target directory.\n  ${USAGE}`);
  }
  return name === undefined ? { target } : { target, name };
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

function main(): void {
  const { target, name: nameFlag } = parseArgs(process.argv);
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
}

main();
