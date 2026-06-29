#!/usr/bin/env node

// Wires the oss-dev MCP server into this platform repo's .mcp.json + trusts it in
// .claude/settings.json. OSS-repo only: scaffolded consumers ship their own .mcp.json
// (pointing at node_modules/@blurifycom/mcp) via `pnpm create:app`, so there is no
// consumer --target path here anymore.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ossRoot = resolve(here, '..');

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

const OSS_MCP = {
  mcpServers: {
    'oss-dev': {
      type: 'stdio',
      command: 'pnpm',
      args: ['exec', 'tsx', 'apps/mcp-server-dev/src/main.ts'],
    },
  },
};

function main(): void {
  const log: string[] = [];

  const mcpPath = join(ossRoot, '.mcp.json');
  let mcp = readJson<{ mcpServers?: Record<string, unknown> }>(mcpPath, {});
  if (!mcp.mcpServers || Object.keys(mcp.mcpServers).length === 0) {
    mcp = OSS_MCP;
    writeJson(mcpPath, mcp);
    log.push('wrote .mcp.json (oss-dev server)');
  } else {
    log.push(`.mcp.json present (servers: ${Object.keys(mcp.mcpServers).join(', ')})`);
  }
  const serverNames = Object.keys(mcp.mcpServers ?? {});

  const settingsPath = join(ossRoot, '.claude', 'settings.json');
  const settings = readJson<{
    enabledMcpjsonServers?: string[];
    enableAllProjectMcpServers?: boolean;
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

  if (changed) {
    settings.enabledMcpjsonServers = [...enabled];
    writeJson(settingsPath, settings);
    log.push(`updated .claude/settings.json (trust: ${[...enabled].join(', ')})`);
  } else {
    log.push('.claude/settings.json already up to date');
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
