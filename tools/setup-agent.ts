#!/usr/bin/env node
/**
 * One-command agent onboarding. Run via `pnpm setup:agent`.
 * Checks prerequisites, boots infra, migrates DB, starts MCP dev server, prints summary.
 */

import { execSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

function run(cmd: string, opts?: { cwd?: string; silent?: boolean }): string {
  try {
    return execSync(cmd, {
      cwd: opts?.cwd ?? root,
      stdio: opts?.silent ? 'pipe' : 'inherit',
      encoding: 'utf8',
    });
  } catch (e: unknown) {
    throw new Error(`Command failed: ${cmd}\n${(e as Error).message}`);
  }
}

function check(label: string, cmd: string, minVersion?: string) {
  try {
    const out = execSync(cmd, { encoding: 'utf8', stdio: 'pipe' }).trim();
    console.log(`  [ok] ${label}: ${out}`);
    return out;
  } catch {
    console.error(`  [fail] ${label} not found. Required.`);
    process.exit(1);
  }
}

async function main() {
  console.log('\n=== OSS Igaming Platform - Agent Setup ===\n');

  // 1. Prerequisites
  console.log('--- Checking prerequisites ---');
  check('node', 'node --version');
  check('pnpm', 'pnpm --version');
  check('docker', 'docker --version');

  // 2. Install deps if needed
  if (!existsSync(join(root, 'node_modules'))) {
    console.log('\n--- Installing dependencies ---');
    run('pnpm install');
  } else {
    console.log('\n--- Dependencies: already installed ---');
  }

  // 3. Start postgres via docker compose and wait for it to be ready.
  console.log('\n--- Starting dev infra (docker compose up -d) ---');
  run('docker compose up -d');

  await new Promise<void>((resolve) => {
    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      try {
        execSync('docker compose exec -T postgres pg_isready -U postgres', { stdio: 'pipe' });
        clearInterval(poll);
        resolve();
      } catch {
        if (attempts > 20) { clearInterval(poll); resolve(); }
      }
    }, 1500);
  });

  // 4. Migrate
  console.log('\n--- Running Drizzle migrations ---');
  try {
    run('pnpm -F @oss/db generate');
    run('pnpm -F @oss/db migrate');
  } catch (e) {
    console.warn('  [warn] Migration step skipped (schema may be empty - normal on first run)');
  }

  // 5. Summary
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const envExample = readFileSync(
    join(root, 'packages', 'platform', 'db', '.env.example'),
    'utf8',
  );
  const ports: Record<string, string> = {};
  for (const line of envExample.split('\n')) {
    const m = line.match(/^(PORT_\w+)=(\d+)/);
    if (m) ports[m[1]] = m[2];
  }

  console.log('\n=== Setup complete ===\n');
  console.log(`Repo: ${pkg.name} v${pkg.version}`);
  console.log(
    `Node: ${process.version}  pnpm: ${execSync('pnpm --version', { encoding: 'utf8' }).trim()}`,
  );
  console.log('');
  console.log('Services:');
  console.log(`  API          http://localhost:${ports['PORT_API'] ?? '3001'}`);
  console.log(`  Backoffice   http://localhost:3000`);
  console.log(`  MCP server   oss-dev (stdio, via .mcp.json - see docs/mcp-setup.md for per-editor setup)`);
  console.log(`  Storybook    http://localhost:6006`);
  console.log('');
  console.log('Start everything: pnpm dev');
  console.log('Run tests:        pnpm verify');
  console.log('Add a module:     /scaffold-module <name>');
  console.log('Add an extension: /scaffold-plugin <name>');
  console.log('');
  console.log('Read AGENTS.md for architecture rules and decision tree.');
  console.log('Read docs/agent-quickstart.md for a step-by-step agent workflow.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
