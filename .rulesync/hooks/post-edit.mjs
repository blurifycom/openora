#!/usr/bin/env node
// PostToolUse hook (Claude / Copilot CLI / Codex CLI).
// Formats the edited file (oxfmt), then typechecks the package that owns it and
// reports (exit 2) only if the error is in the file just edited. Output is capped
// so a failure can't balloon the model context. Fail-open on anything unexpected.

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, isAbsolute, relative } from 'node:path';
import { extractFilePath, readPayload } from './_shared.mjs';

const CAP_LINES = 40;
const CAP_CHARS = 2000;

const filePath = extractFilePath(readPayload());
if (!filePath) process.exit(0);
if (!/\.(ts|tsx)$/.test(filePath) || filePath.endsWith('d.ts')) process.exit(0);
if (filePath.includes('/templates/') || filePath.includes('/generated/')) process.exit(0);

// Format (best effort - never block on the formatter).
try {
  execSync(`pnpm exec oxfmt "${filePath}"`, { stdio: 'pipe' });
} catch {
  /* oxfmt unavailable or errored - fall through to typecheck */
}

// Resolve the owning workspace package (apps/<x> or packages/<group>/<x>).
function packageNameFor(fp) {
  const m = fp.match(/(.*?\/(?:apps\/[^/]+|packages\/[^/]+\/[^/]+))\//);
  if (!m) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(m[1], 'package.json'), 'utf8'));
    if (!pkg.name || !pkg.scripts?.typecheck) return null;
    return pkg.name;
  } catch {
    return null;
  }
}

const abs = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);
const owner = packageNameFor(abs);
if (!owner) process.exit(0);

function cap(text) {
  const out = text.split('\n').slice(0, CAP_LINES).join('\n').slice(0, CAP_CHARS);
  return out.length < text.length ? `${out}\n... (truncated)` : out;
}

try {
  execSync(`pnpm --filter "${owner}" typecheck`, { stdio: 'pipe' });
  process.exit(0);
} catch (e) {
  const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  const basename = (isAbsolute(filePath) ? relative(process.cwd(), filePath) : filePath).split('/').pop() ?? '';
  if (basename && output.includes(basename)) {
    process.stderr.write(`Typecheck failed for ${owner} after editing ${basename}:\n${cap(output)}`);
    process.exit(2);
  }
  process.exit(0);
}
