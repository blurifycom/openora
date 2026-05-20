#!/usr/bin/env node
/**
 * Single source = AGENTS.md. Regenerates derived files agents read.
 *
 * Outputs:
 *   CLAUDE.md                            - preserves head matter, replaces section after @AGENTS.md marker
 *   .cursorrules                         - full AGENTS.md content
 *   .github/copilot-instructions.md      - full AGENTS.md content
 *
 * Run: pnpm sync:agent-docs
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
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
    path: join(repoRoot, '.cursorrules'),
    transform: (s) => banner('cursor') + s,
  },
  {
    path: join(repoRoot, '.github', 'copilot-instructions.md'),
    transform: (s) => banner('copilot') + s,
  },
  {
    path: join(repoRoot, 'CLAUDE.md'),
    transform: (s) => rewriteClaude(s),
  },
];

let changed = 0;
for (const t of targets) {
  const next = t.transform(source);
  const prev = existsSync(t.path) ? readFileSync(t.path, 'utf8') : '';
  if (prev === next) continue;
  writeFileSync(t.path, next);
  console.log('updated', t.path);
  changed += 1;
}
if (changed === 0) console.log('agent docs already in sync');

function banner(target: string): string {
  return `<!-- AUTO-GENERATED from AGENTS.md by tools/sync-agent-docs.ts. Do not edit directly. Target: ${target} -->\n\n`;
}

function rewriteClaude(agents: string): string {
  const claudePath = join(repoRoot, 'CLAUDE.md');
  const claude = existsSync(claudePath) ? readFileSync(claudePath, 'utf8') : '';
  const marker = '@AGENTS.md';
  const idx = claude.indexOf(marker);
  if (idx === -1) {
    // first write or marker missing - regenerate from scratch with embedded content
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
  // keep head matter, replace marker + everything after with embedded content
  return claude.slice(0, idx) + agents;
}
