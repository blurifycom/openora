#!/usr/bin/env node
/**
 * Single source = AGENTS.md. Regenerates derived files that each editor/agent reads.
 *
 * Outputs:
 *   CLAUDE.md                          - Claude Code (preserves head matter)
 *   .cursorrules                       - Cursor, Windsurf, and any editor reading this file
 *   .github/copilot-instructions.md   - GitHub Copilot
 *
 * Run: pnpm sync:agent-docs
 * CI drift gate: pnpm verify:drift
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const sourcePath = join(repoRoot, 'AGENTS.md');
if (!existsSync(sourcePath)) {
  console.error('AGENTS.md missing at repo root. Refusing to sync.');
  process.exit(1);
}
const source = readFileSync(sourcePath, 'utf8');

const targets: Array<{ path: string; transform: (s: string) => string }> = [
  {
    path: join(repoRoot, 'CLAUDE.md'),
    transform: (s) => rewriteClaude(s),
  },
  {
    path: join(repoRoot, '.cursorrules'),
    transform: (s) =>
      [
        '# Agent instructions for Cursor / Windsurf',
        '',
        'Auto-generated from `AGENTS.md` by `pnpm sync:agent-docs`. Edit `AGENTS.md`, not this file.',
        '',
        '---',
        '',
        s,
      ].join('\n'),
  },
  {
    path: join(repoRoot, '.github', 'copilot-instructions.md'),
    transform: (s) =>
      [
        '<!-- GitHub Copilot instructions -->',
        '<!-- Auto-generated from AGENTS.md by `pnpm sync:agent-docs`. Edit AGENTS.md, not this file. -->',
        '',
        s,
      ].join('\n'),
  },
];

let changed = 0;
for (const t of targets) {
  const dir = dirname(t.path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const next = t.transform(source);
  const prev = existsSync(t.path) ? readFileSync(t.path, 'utf8') : '';
  if (prev === next) continue;
  writeFileSync(t.path, next);
  console.log('updated', t.path);
  changed += 1;
}
if (changed === 0) console.log('agent docs already in sync');

function rewriteClaude(agents: string): string {
  const claudePath = join(repoRoot, 'CLAUDE.md');
  const claude = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  const marker = '@AGENTS.md';
  const idx = claude.indexOf(marker);
  if (idx === -1) {
    return [
      '# CLAUDE.md',
      '',
      'Auto-generated header by `pnpm sync:agent-docs`. Edit `AGENTS.md`, not this file.',
      '',
      '---',
      '',
      agents,
    ].join('\n');
  }
  return claude.slice(0, idx) + agents;
}
