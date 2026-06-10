#!/usr/bin/env node
/**
 * Bootstrap a downstream igaming project that consumes @oss/* via local `link:`.
 *
 * Usage:
 *   pnpm create:app <target-dir> [--name <project-name>]
 *
 * Example:
 *   pnpm create:app ../my-igaming --name my-igaming
 *
 * Scaffolds a headless api-only turborepo (apps/api), wires pnpm.overrides to link
 * at this OSS checkout, drops in the consumer AI agents and turbo gen generators,
 * then prints next steps.
 *
 * The platform is headless: the frontend (player web + backoffice admin) lives in
 * the downstream consumer's own repo and talks to this api over HTTP via the SDK
 * (`@oss/sdk-core` / `@oss/react-hooks`). The scaffold ships only the backend.
 *
 * The base lives in `tools/templates/consumer/` (root config + apps/api +
 * generators + dotfiles). The __dot__/.tpl/substitution rules apply throughout.
 */

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
  copyFileSync,
} from 'node:fs';
import { join, dirname, relative, resolve, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ossRoot = resolve(here, '..');
const templateRoot = join(here, 'templates', 'consumer');
const agentsDir = join(ossRoot, 'packages', 'platform', 'mcp', 'agents');

type ParsedArgs = {
  target: string;
  name?: string;
};

function die(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

const USAGE = 'Usage: pnpm create:app <target-dir> [--name <name>]';

// Accepts `--flag value` and `--flag=value`. Returns the raw value or undefined.
function readFlag(args: string[], i: number): { value: string | undefined; next: number } {
  const a = args[i];
  const eq = a.indexOf('=');
  if (eq !== -1) return { value: a.slice(eq + 1), next: i };
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
  if (!target) die(`missing target directory.\n  ${USAGE}`);
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

// Forward slashes for use inside package.json / TS string literals on every OS.
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
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

// __dot__foo -> .foo  (lets us store dotfiles in-repo without them taking effect here)
function undotSegment(seg: string): string {
  return seg.startsWith('__dot__') ? `.${seg.slice('__dot__'.length)}` : seg;
}

// Copy a template tree into the target, mapping each file's relative path through
// the __dot__ / .tpl rules and substituting {{vars}} in .tpl files only.
function emitTree(srcRoot: string, vars: Record<string, string>, targetDir: string): void {
  for (const file of walk(srcRoot)) {
    const rel = relative(srcRoot, file);
    let outRel = rel.split(sep).map(undotSegment).join(sep);
    if (outRel.endsWith('.tpl')) outRel = outRel.slice(0, -'.tpl'.length);

    // Only .tpl files get {{var}} substitution. Everything else is copied verbatim so
    // that, eg, files carrying their own {{name}} Plop placeholders survive untouched.
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
  if (!existsSync(templateRoot)) die(`template missing at ${templateRoot}`);

  const vars: Record<string, string> = {
    name,
    ossFromRoot: posix(relative(targetDir, ossRoot)),
    ossFromApp: posix(relative(join(targetDir, 'apps', 'api'), ossRoot)),
    ossFromApiSrc: posix(relative(join(targetDir, 'apps', 'api', 'src'), ossRoot)),
  };

  console.log(`\n  Creating ${name} at ${targetDir}`);
  console.log(`  headless api-only consumer (frontend lives in your own repo)`);
  console.log(`  Linking @oss/* from ${vars.ossFromRoot}\n`);

  // Base consumer repo (root config + apps/api + generators + dotfiles).
  emitTree(templateRoot, vars, targetDir);

  // Drop in the consumer AI agents as rulesync subagent sources (single source of
  // truth: @oss/mcp/agents, already in rulesync format). `pnpm sync:agents`
  // generates the per-tool mirrors (.claude/agents, .github/agents).
  const rulesyncSubagents = join(targetDir, '.rulesync', 'subagents');
  mkdirSync(rulesyncSubagents, { recursive: true });
  for (const f of [
    'igaming-builder.md',
    'igaming-expert.md',
    'igaming-qa.md',
    'igaming-debugger.md',
    'igaming-deployer.md',
  ]) {
    const src = join(agentsDir, f);
    if (existsSync(src)) {
      copyFileSync(src, join(rulesyncSubagents, f));
      console.log(`  + .rulesync/subagents/${f}`);
    }
  }

  console.log(`
  Done. Next steps:

    cd ${posix(relative(process.cwd(), targetDir)) || '.'}
    pnpm install            # also generates the agent files (CLAUDE.md / AGENTS.md / .codex/config.toml / Copilot) from .rulesync/ via the prepare hook
    pnpm build:oss          # build the linked @oss/* packages once
    cp .env.example .env     # then set DATABASE_URL / AUTH_SECRET
    pnpm db:migrate          # apply the OSS schema to your database
    pnpm dev                 # api :3001

  Add features with turbo gen:

    pnpm gen plugin          # new overlay plugin
    pnpm gen adapter         # swap a vendor adapter (KYC / payment / notification)

  This is a headless api. Build your frontend in its own repo and consume the
  api over HTTP with @oss/sdk-core / @oss/react-hooks.
`);
}

main();
