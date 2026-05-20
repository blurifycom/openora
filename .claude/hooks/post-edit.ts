#!/usr/bin/env node
/**
 * Post-edit hook: runs typecheck on the package containing the edited file.
 * Called by Claude Code after every Edit/Write tool use.
 *
 * Exits 0 (pass) or 1 (block the edit and show the error).
 * Only runs if the file is a .ts/.tsx source file - skips templates, configs, docs.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

const filePath = process.argv[2] ?? '';

// Skip non-source files
if (!/\.(ts|tsx)$/.test(filePath) || /\.(d\.ts)$/.test(filePath)) process.exit(0);
if (filePath.includes('/templates/') || filePath.includes('/generated/')) process.exit(0);

// Determine which workspace package owns the file
function findPackageFilter(fp: string): string | null {
  // Check if file is in apps/* or packages/*/*
  const match = fp.match(/(apps\/[^/]+|packages\/[^/]+\/[^/]+)\//);
  if (!match) return null;
  try {
    const pkg = JSON.parse(
      require('node:fs').readFileSync(
        join(fp.split(match[1])[0], match[1], 'package.json'),
        'utf8',
      ),
    );
    return pkg.name as string;
  } catch {
    return null;
  }
}

const filter = findPackageFilter(filePath);
const cmd = filter ? `pnpm --filter "${filter}" typecheck 2>&1` : `pnpm typecheck 2>&1`;

try {
  execSync(cmd, { stdio: 'pipe', cwd: process.env['REPO_ROOT'] ?? process.cwd() });
  process.exit(0);
} catch (e: unknown) {
  const output = (e as { stdout?: Buffer; stderr?: Buffer }).stdout?.toString() ?? '';
  // Only block on errors in the edited file itself to avoid false positives
  if (output.includes(filePath.split('/').pop() ?? '')) {
    process.stderr.write(output);
    process.exit(1);
  }
  process.exit(0);
}
