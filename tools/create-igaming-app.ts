#!/usr/bin/env node
/**
 * Bootstrap a downstream igaming project that consumes @oss/* via local `link:`.
 *
 * Usage:
 *   pnpm create:app <target-dir> [--name <project-name>]
 *                                 [--web next|tanstack] [--backoffice next|vite]
 *
 * Examples:
 *   pnpm create:app ../my-igaming --name my-igaming
 *   pnpm create:app ../poc --web=tanstack --backoffice=vite
 *
 * Scaffolds a full turborepo (apps/api + web + backoffice), wires pnpm.overrides
 * to link at this OSS checkout, drops in the consumer AI agents and turbo gen
 * generators, then prints next steps.
 *
 * The shared base lives in `tools/templates/consumer/` (root config + apps/api +
 * generators + dotfiles). The per-app trees live in `tools/templates/variants/`:
 * `web-next` / `web-tanstack` overlay onto `apps/web`, and `backoffice-next` /
 * `backoffice-vite` overlay onto `apps/backoffice`. Same __dot__/.tpl/substitution
 * rules apply to base and variants alike.
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
const variantsRoot = join(here, 'templates', 'variants');
const agentsDir = join(ossRoot, 'packages', 'platform', 'mcp', 'agents');

const WEB_VARIANTS = ['next', 'tanstack'] as const;
const BACKOFFICE_VARIANTS = ['next', 'vite'] as const;
type WebVariant = (typeof WEB_VARIANTS)[number];
type BackofficeVariant = (typeof BACKOFFICE_VARIANTS)[number];

type ParsedArgs = {
  target: string;
  name?: string;
  web: WebVariant;
  backoffice: BackofficeVariant;
};

function die(msg: string): never {
  console.error(`\n  error: ${msg}\n`);
  process.exit(1);
}

const USAGE =
  'Usage: pnpm create:app <target-dir> [--name <name>] [--web next|tanstack] [--backoffice next|vite]';

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
  let web: WebVariant = 'next';
  let backoffice: BackofficeVariant = 'vite';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--name' || a.startsWith('--name=')) {
      const r = readFlag(args, i);
      name = r.value;
      i = r.next;
    } else if (a === '--web' || a.startsWith('--web=')) {
      const r = readFlag(args, i);
      i = r.next;
      if (r.value === undefined || !(WEB_VARIANTS as readonly string[]).includes(r.value)) {
        die(`--web must be one of: ${WEB_VARIANTS.join(', ')}.\n  ${USAGE}`);
      }
      web = r.value as WebVariant;
    } else if (a === '--backoffice' || a.startsWith('--backoffice=')) {
      const r = readFlag(args, i);
      i = r.next;
      if (
        r.value === undefined ||
        !(BACKOFFICE_VARIANTS as readonly string[]).includes(r.value)
      ) {
        die(`--backoffice must be one of: ${BACKOFFICE_VARIANTS.join(', ')}.\n  ${USAGE}`);
      }
      backoffice = r.value as BackofficeVariant;
    } else if (!a.startsWith('-') && !target) {
      target = a;
    }
  }
  if (!target) die(`missing target directory.\n  ${USAGE}`);
  return { target, name, web, backoffice };
}

function sanitizeName(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/^-+|-+$/g, '') || 'igaming-app';
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

// Copy a template tree (base or variant) into the target, mapping each file's
// relative path through the __dot__ / .tpl rules and substituting {{vars}} in .tpl
// files only. `destPrefix` rebases the output (eg a variant tree lands under
// `apps/web`).
function emitTree(
  srcRoot: string,
  vars: Record<string, string>,
  targetDir: string,
  destPrefix = '',
): void {
  for (const file of walk(srcRoot)) {
    const rel = relative(srcRoot, file);
    let outRel = rel.split(sep).map(undotSegment).join(sep);
    if (outRel.endsWith('.tpl')) outRel = outRel.slice(0, -'.tpl'.length);
    if (destPrefix) outRel = join(destPrefix, outRel);

    // Only .tpl files get {{var}} substitution. Everything else is copied verbatim so
    // that, eg, turbo generator .hbs files keep their own {{name}} Plop placeholders.
    const raw = readFileSync(file, 'utf8');
    const content = file.endsWith('.tpl') ? substitute(raw, vars) : raw;

    const outPath = join(targetDir, outRel);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, content);
    console.log(`  + ${posix(outRel)}`);
  }
}

function main(): void {
  const { target, name: nameFlag, web, backoffice } = parseArgs(process.argv);
  const targetDir = resolve(process.cwd(), target);
  const name = sanitizeName(nameFlag ?? basename(targetDir));

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    die(`${targetDir} already exists and is not empty.`);
  }
  if (!existsSync(templateRoot)) die(`template missing at ${templateRoot}`);

  const webVariantDir = join(variantsRoot, `web-${web}`);
  const backofficeVariantDir = join(variantsRoot, `backoffice-${backoffice}`);
  if (!existsSync(webVariantDir)) die(`web variant missing at ${webVariantDir}`);
  if (!existsSync(backofficeVariantDir)) {
    die(`backoffice variant missing at ${backofficeVariantDir}`);
  }

  const vars: Record<string, string> = {
    name,
    ossFromRoot: posix(relative(targetDir, ossRoot)),
    ossFromApp: posix(relative(join(targetDir, 'apps', 'api'), ossRoot)),
    ossFromApiSrc: posix(relative(join(targetDir, 'apps', 'api', 'src'), ossRoot)),
  };

  console.log(`\n  Creating ${name} at ${targetDir}`);
  console.log(`  web: ${web}   backoffice: ${backoffice}`);
  console.log(`  Linking @oss/* from ${vars.ossFromRoot}\n`);

  // 1) Shared base (root config + apps/api + generators + dotfiles).
  emitTree(templateRoot, vars, targetDir);
  // 2) Chosen player app overlays onto apps/web.
  emitTree(webVariantDir, vars, targetDir, join('apps', 'web'));
  // 3) Chosen admin app overlays onto apps/backoffice.
  emitTree(backofficeVariantDir, vars, targetDir, join('apps', 'backoffice'));

  // Drop in the consumer AI agents (single source of truth: @oss/mcp/agents).
  const claudeAgents = join(targetDir, '.claude', 'agents');
  mkdirSync(claudeAgents, { recursive: true });
  for (const f of ['igaming-builder.md', 'igaming-expert.md', 'igaming-qa.md', 'igaming-debugger.md']) {
    const src = join(agentsDir, f);
    if (existsSync(src)) {
      copyFileSync(src, join(claudeAgents, f));
      console.log(`  + .claude/agents/${f}`);
    }
  }

  console.log(`
  Done. Next steps:

    cd ${posix(relative(process.cwd(), targetDir)) || '.'}
    pnpm install
    pnpm build:oss          # build the linked @oss/* packages once
    cp .env.example .env     # then set DATABASE_URL / AUTH_SECRET
    pnpm db:migrate          # apply the OSS schema to your database
    pnpm dev                 # api :3001, web :3000, backoffice :3002

  Add features with turbo gen:

    pnpm gen plugin          # new overlay plugin
    pnpm gen adapter         # swap a vendor adapter (KYC / payment / notification)
    pnpm gen page            # mount an @oss/react-sdk page on a route
`);
}

main();
