#!/usr/bin/env node
// PostToolUse hook (Claude / Copilot CLI / Codex CLI / Gemini CLI).
// Lint-fixes the edited files, then typechecks the apps that own them and reports
// (exit 2) only if the error is in a file just edited. Output is capped so a
// failure can't balloon the model context. Fail-open on anything unexpected.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, isAbsolute } from 'node:path';
import { extractFilePaths, readPayload } from './_shared.mjs';

const CAP_LINES = 40;
const CAP_CHARS = 2000;

const filePaths = extractFilePaths(readPayload()).filter(
  (filePath) =>
    /\.(ts|tsx)$/.test(filePath) &&
    !filePath.endsWith('.d.ts') &&
    !filePath.includes('/templates/') &&
    !filePath.includes('/generated/') &&
    existsSync(filePath),
);
if (filePaths.length === 0) {
  process.exit(0);
}
const edited = filePaths.join(', ');

/**
 * node_modules/.bin/<name> when it exists, else the bare name off PATH. `pnpm exec`
 * costs ~2.2s of package-manager startup per call against ~0.12s for the binary, and
 * this hook runs on every edit.
 */
function bin(name) {
  const local = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), 'node_modules/.bin', name);
  return existsSync(local) ? local : name;
}

function cap(text) {
  const out = text.split('\n').slice(0, CAP_LINES).join('\n').slice(0, CAP_CHARS);
  return out.length < text.length ? `${out}\n... (truncated)` : out;
}

// Lint-fix (best effort - never block on the linter).
try {
  execFileSync(bin('oxlint'), ['--fix', ...filePaths], { stdio: 'pipe' });
} catch {
  /* oxlint unavailable or errored - fall through to the re-lint / typecheck */
}

// Re-lint WITHOUT --fix to surface UNFIXABLE errors the agent must resolve by
// hand - import/no-cycle and the no-restricted-imports boundary rules (deep @openora
// or {{scope}}/ui imports, app-to-app imports). oxlint exits non-zero on errors
// only (warnings don't fail), so this blocks on a real boundary/cycle violation
// in an edited file and feeds the message back. Fail-open on anything else.
try {
  execFileSync(bin('oxlint'), filePaths, { stdio: 'pipe' });
} catch (e) {
  const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  if (/\berror\b/.test(out)) {
    process.stderr.write(`Boundary/lint error in ${edited} - fix before continuing:\n${cap(out)}`);
    process.exit(2);
  }
}

// Resolve the owning workspace app (apps/<x> or packages/<x>).
function packageNameFor(fp) {
  const m = fp.match(/(.*?\/(?:apps|packages)\/[^/]+)\//);
  if (!m) {
    return null;
  }
  try {
    const pkg = JSON.parse(readFileSync(join(m[1], 'package.json'), 'utf8'));
    if (!pkg.name || !pkg.scripts?.['check:types']) {
      return null;
    }
    return pkg.name;
  } catch {
    return null;
  }
}

const owners = [
  ...new Set(
    filePaths
      .map((filePath) => packageNameFor(isAbsolute(filePath) ? filePath : join(process.cwd(), filePath)))
      .filter(Boolean),
  ),
];
if (owners.length === 0) {
  process.exit(0);
}

try {
  execFileSync(
    bin('turbo'),
    [
      'run',
      'check:types',
      ...owners.flatMap((owner) => ['--filter', owner]),
      '--output-logs=errors-only',
      '--ui=stream',
    ],
    { stdio: 'pipe' },
  );
  process.exit(0);
} catch (e) {
  const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  const failing = filePaths.map((filePath) => basename(filePath)).filter((name) => output.includes(name));
  if (failing.length > 0) {
    process.stderr.write(
      `Typecheck failed for ${owners.join(', ')} after editing ${failing.join(', ')}:\n${cap(output)}`,
    );
    process.exit(2);
  }
  process.exit(0);
}
