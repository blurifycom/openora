#!/usr/bin/env node
/**
 * Removes generated agent mirrors whose source no longer exists in .rulesync/.
 * rulesync runs with `delete: false` (the target dirs also hold hand-kept files),
 * so a renamed or deleted skill or subagent would otherwise survive in every
 * existing checkout. Runs after `rulesync generate` in `pnpm gen:agents`.
 */
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MIRRORS = [
  {
    source: '.rulesync/skills',
    targets: ['.claude/skills', '.agents/skills', '.github/skills', '.codex/skills'],
  },
  { source: '.rulesync/subagents', targets: ['.claude/agents', '.github/agents', '.codex/agents'] },
];

const entries = (dir) => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []);
const nameOf = (entry) => entry.name.split('.')[0];

const stale = MIRRORS.flatMap(({ source, targets }) => {
  const known = new Set(entries(source).map(nameOf));
  return targets.flatMap((target) =>
    entries(target)
      .filter((entry) => !known.has(nameOf(entry)))
      .map((entry) => join(target, entry.name)),
  );
});

stale.forEach((path) => rmSync(path, { recursive: true, force: true }));
console.log(stale.length ? `pruned stale mirrors: ${stale.join(', ')}` : 'no stale agent mirrors');
