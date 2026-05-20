#!/usr/bin/env node
/**
 * PostToolUse hook (Edit|Write): typechecks the package that owns the edited
 * file and blocks only if the error is in that file. Keeps the agent honest
 * about type errors it just introduced, without blocking on pre-existing
 * errors elsewhere.
 *
 * Claude Code passes hook data as JSON on stdin (NOT env vars). We read
 * `tool_input.file_path` from it. Exit 2 = block + feed stderr back to the
 * model; exit 0 = pass.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let filePath = '';
try {
  const payload = JSON.parse(readStdin() || '{}') as { tool_input?: { file_path?: string } };
  filePath = payload.tool_input?.file_path ?? '';
} catch {
  process.exit(0); // malformed payload - never block
}

// Only typecheck source files; skip declarations, templates, generated output.
if (!/\.(ts|tsx)$/.test(filePath) || /\.d\.ts$/.test(filePath)) process.exit(0);
if (filePath.includes('/templates/') || filePath.includes('/generated/')) process.exit(0);

// Resolve the owning workspace package (apps/<x> or packages/<group>/<x>).
function packageNameFor(fp: string): { name: string; dir: string } | null {
  const match = fp.match(/(.*?\/(?:apps\/[^/]+|packages\/[^/]+\/[^/]+))\//);
  if (!match) return null;
  const dir = match[1];
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name?: string;
      scripts?: Record<string, string>;
    };
    if (!pkg.name || !pkg.scripts?.['typecheck']) return null;
    return { name: pkg.name, dir };
  } catch {
    return null;
  }
}

const owner = packageNameFor(filePath);
if (!owner) process.exit(0); // no typecheck script - nothing to do

try {
  execSync(`pnpm --filter "${owner.name}" typecheck`, { stdio: 'pipe' });
  process.exit(0);
} catch (e: unknown) {
  const err = e as { stdout?: Buffer; stderr?: Buffer };
  const output = (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? '');
  const basename = filePath.split('/').pop() ?? '';
  // Block only when the error is in the file we just edited.
  if (basename && output.includes(basename)) {
    process.stderr.write(`Typecheck failed for ${owner.name} after editing ${basename}:\n${output}`);
    process.exit(2);
  }
  process.exit(0);
}
