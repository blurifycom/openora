#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ossRoot = resolve(here, '..');

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

const OSS_MCP = {
  mcpServers: {
    'oss-dev': {
      type: 'stdio',
      command: 'pnpm',
      args: ['exec', 'tsx', 'apps/mcp-server-dev/src/main.ts'],
    },
  },
};

function consumerMcp() {
  return {
    mcpServers: {
      oss: {
        type: 'stdio',
        // Resolved from node_modules (works with a local link: or a published install) -
        // @blurifycom/mcp ships its built dist + bundled catalog.json, so no platform checkout.
        command: 'node',
        args: ['node_modules/@blurifycom/mcp/dist/main.js'],
      },
    },
  };
}

function main(): void {
  const target = parseTarget(process.argv);
  const isOss = target === ossRoot;
  const ossRel = posix(relative(target, ossRoot)) || '..';
  const log: string[] = [];

  const mcpPath = join(target, '.mcp.json');
  let mcp = readJson<{ mcpServers?: Record<string, unknown> }>(mcpPath, {});
  if (!mcp.mcpServers || Object.keys(mcp.mcpServers).length === 0) {
    mcp = isOss ? OSS_MCP : consumerMcp();
    writeJson(mcpPath, mcp);
    log.push(`wrote .mcp.json (${isOss ? 'oss-dev' : 'oss'} server)`);
  } else {
    log.push(`.mcp.json present (servers: ${Object.keys(mcp.mcpServers).join(', ')})`);
  }
  const serverNames = Object.keys(mcp.mcpServers ?? {});

  const settingsPath = join(target, '.claude', 'settings.json');
  const settings = readJson<{
    enabledMcpjsonServers?: string[];
    enableAllProjectMcpServers?: boolean;
    permissions?: { deny?: string[]; [k: string]: unknown };
    [k: string]: unknown;
  }>(settingsPath, {});
  let changed = false;

  const enabled = new Set(settings.enabledMcpjsonServers ?? []);
  for (const name of serverNames)
    if (!enabled.has(name)) {
      enabled.add(name);
      changed = true;
    }
  if (settings.enableAllProjectMcpServers === undefined) {
    settings.enableAllProjectMcpServers = false;
    changed = true;
  }

  if (!isOss) {
    const wanted = [
      'Edit(./node_modules/**)',
      'Write(./node_modules/**)',
      `Edit(${ossRel}/**)`,
      `Write(${ossRel}/**)`,
    ];
    settings.permissions ??= {};
    const deny = new Set(settings.permissions.deny ?? []);
    for (const d of wanted)
      if (!deny.has(d)) {
        deny.add(d);
        changed = true;
      }
    settings.permissions.deny = [...deny];
  }

  if (changed) {
    settings.enabledMcpjsonServers = [...enabled];
    writeJson(settingsPath, settings);
    log.push(
      `updated .claude/settings.json (trust: ${[...enabled].join(', ')}${isOss ? '' : ' + core-edit guardrail'})`,
    );
  } else {
    log.push('.claude/settings.json already up to date');
  }

  if (!isOss) {
    const rulesyncCfg = join(target, 'rulesync.jsonc');
    if (existsSync(rulesyncCfg)) {
      log.push(
        'run `pnpm sync:agents` in your repo to regenerate CLAUDE.md + agent files from .rulesync/',
      );
    }
  }

  console.log('\n  MCP setup');
  for (const l of log) console.log(`  - ${l}`);
  console.log(`
  Next:
    1. Restart your editor (or run /mcp) so it picks up .mcp.json.
    2. In Claude Code, run /start (or say "help me build X").
`);
}

main();
