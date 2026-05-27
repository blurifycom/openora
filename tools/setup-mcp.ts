#!/usr/bin/env node
/**
 * Bring a repo's AI onboarding surface up to date for Claude Code. Idempotent.
 *
 * Usage:
 *   pnpm setup:mcp                      # operate on this OSS repo
 *   tsx tools/setup-mcp.ts --target .   # operate on the cwd (consumers call this)
 *
 * In the OSS repo: ensures .mcp.json and trusts the oss-dev server.
 * In a consumer repo (target is not this checkout): also writes the editor
 * guardrail (deny edits to node_modules + the linked OSS checkout), installs the
 * /start onboarding skill, and drops a CLAUDE.md if the repo does not have one.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ossRoot = resolve(here, '..');
const consumerTpl = join(ossRoot, 'tools', 'templates', 'consumer');

function parseTarget(argv: string[]): string {
  const args = argv.slice(2);
  const i = args.indexOf('--target');
  return i >= 0 && args[i + 1] ? resolve(process.cwd(), args[i + 1]!) : ossRoot;
}

function readJson<T>(p: string, fallback: T): T {
  if (!existsSync(p)) return fallback;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

function writeJson(p: string, data: unknown): void {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `${JSON.stringify(data, null, 2)}\n`);
}

const posix = (p: string): string => p.split(sep).join('/');

const DEFAULT_MCP = {
  mcpServers: {
    'oss-dev': {
      type: 'stdio',
      command: 'pnpm',
      args: ['exec', 'tsx', 'apps/mcp-server-dev/src/main.ts'],
    },
  },
};

function main(): void {
  const target = parseTarget(process.argv);
  const isOss = target === ossRoot;
  const log: string[] = [];

  // 1. .mcp.json - ensure at least one server is registered.
  const mcpPath = join(target, '.mcp.json');
  let mcp = readJson<{ mcpServers?: Record<string, unknown> }>(mcpPath, {});
  if (!mcp.mcpServers || Object.keys(mcp.mcpServers).length === 0) {
    mcp = DEFAULT_MCP;
    writeJson(mcpPath, mcp);
    log.push('wrote .mcp.json (oss-dev server)');
  } else {
    log.push(`.mcp.json present (servers: ${Object.keys(mcp.mcpServers).join(', ')})`);
  }
  const serverNames = Object.keys(mcp.mcpServers ?? {});

  // 2. .claude/settings.json - trust the servers + (consumer) deny edits to core.
  const settingsPath = join(target, '.claude', 'settings.json');
  const settings = readJson<{
    enabledMcpjsonServers?: string[];
    enableAllProjectMcpServers?: boolean;
    permissions?: { deny?: string[]; [k: string]: unknown };
    [k: string]: unknown;
  }>(settingsPath, {});
  let changed = false;

  const enabled = new Set(settings.enabledMcpjsonServers ?? []);
  for (const name of serverNames) if (!enabled.has(name)) { enabled.add(name); changed = true; }
  if (settings.enableAllProjectMcpServers === undefined) {
    settings.enableAllProjectMcpServers = false;
    changed = true;
  }

  // Consumer guardrail: never let the agent edit the consumed @oss/* source.
  if (!isOss) {
    const ossRel = posix(relative(target, ossRoot)) || '..';
    const wanted = [
      'Edit(./node_modules/**)',
      'Write(./node_modules/**)',
      `Edit(${ossRel}/**)`,
      `Write(${ossRel}/**)`,
    ];
    settings.permissions ??= {};
    const deny = new Set(settings.permissions.deny ?? []);
    for (const d of wanted) if (!deny.has(d)) { deny.add(d); changed = true; }
    settings.permissions.deny = [...deny];
  }

  if (changed) {
    settings.enabledMcpjsonServers = [...enabled];
    writeJson(settingsPath, settings);
    log.push(`updated .claude/settings.json (trust: ${[...enabled].join(', ')}${isOss ? '' : ' + core-edit guardrail'})`);
  } else {
    log.push('.claude/settings.json already up to date');
  }

  // 3. Consumer onboarding files: /start skill + CLAUDE.md (install if missing).
  if (!isOss) {
    const skillSrc = join(consumerTpl, '__dot__claude', 'skills', 'start.md');
    const skillDst = join(target, '.claude', 'skills', 'start.md');
    if (existsSync(skillDst)) {
      log.push('/start skill already present');
    } else if (existsSync(skillSrc)) {
      mkdirSync(dirname(skillDst), { recursive: true });
      copyFileSync(skillSrc, skillDst);
      log.push('installed /start onboarding skill');
    }

    const claudeSrc = join(consumerTpl, 'CLAUDE.md');
    const claudeDst = join(target, 'CLAUDE.md');
    if (existsSync(claudeDst)) {
      log.push('CLAUDE.md already present (left as is)');
    } else if (existsSync(claudeSrc)) {
      copyFileSync(claudeSrc, claudeDst);
      log.push('installed CLAUDE.md (agent instructions)');
    }
  }

  console.log('\n  MCP setup');
  for (const l of log) console.log(`  - ${l}`);
  console.log(`
  Next:
    1. Restart your editor (or run /mcp) so it picks up .mcp.json + skills.
    2. In Claude Code, run /start (or say "help me build X").
`);
}

main();
