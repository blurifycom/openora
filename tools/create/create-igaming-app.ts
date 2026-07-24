#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ossRoot = resolve(here, '../..');
const templateRoot = join(here, '..', 'templates', 'consumer');

type ParsedArgs = {
  target: string;
  name?: string;
};

function die(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

const USAGE = 'Usage: pnpm create:app <target-dir> [--name <name>]';

function readFlag(args: string[], i: number): { value: string | undefined; next: number } {
  const a = args[i];
  const eq = a.indexOf('=');
  if (eq !== -1) {
    return { value: a.slice(eq + 1), next: i };
  }
  return { value: args[i + 1], next: i + 1 };
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let target: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' || a.startsWith('--name=')) {
      const r = readFlag(args, i);
      name = r.value;
      i = r.next;
    } else if (!a.startsWith('-') && !target) {
      target = a;
    }
  }
  if (!target) {
    die(`missing target directory.\n  ${USAGE}`);
  }
  return { target, name };
}

function sanitizeName(raw: string): string {
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, '-')
      .replace(/^-+|-+$/g, '') || 'igaming-app'
  );
}

function posix(p: string): string {
  return p.split(sep).join('/');
}

function substitute(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
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

function undotSegment(seg: string): string {
  return seg.startsWith('__dot__') ? `.${seg.slice('__dot__'.length)}` : seg;
}

function emitTree(srcRoot: string, vars: Record<string, string>, targetDir: string): void {
  for (const file of walk(srcRoot)) {
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

  const ossFromRoot = posix(relative(targetDir, ossRoot));
  const vars: Record<string, string> = {
    name,
    ossFromRoot,
    ossFromApp: posix(relative(join(targetDir, 'apps', 'api'), ossRoot)),
    ossFromApiSrc: posix(relative(join(targetDir, 'apps', 'api', 'src'), ossRoot)),
    coreVersion: 'latest',
    mcpCommand: 'pnpm',
    mcpArgsJson: JSON.stringify(['exec', 'tsx', `${ossFromRoot}/apps/mcp-server-dev/src/main.ts`]),
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
