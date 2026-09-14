#!/usr/bin/env node
// PostToolUse hook (Claude / Copilot CLI / Codex CLI).
// Formats the edited file (oxfmt), then lints it (oxlint) and reports (exit 2) only
// on an error-severity diagnostic. Output is capped so a failure can't balloon the
// model context. Fail-open on anything unexpected.
//
// The binaries are invoked straight out of node_modules/.bin: `pnpm exec` costs
// ~2.2s of package-manager startup per call, the binary itself ~0.12s, and this
// hook is on the critical path of every single edit.
//
// Typechecking deliberately does NOT run here - `tsc --noEmit` over the owning
// package is ~16s per edit. It stays in `pnpm verify`, the /pre-pr gate, and CI.

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { extractFilePath, readPayload } from './_shared.mjs';

const CAP_LINES = 40;
const CAP_CHARS = 2000;

const filePath = extractFilePath(readPayload());
if (!filePath) {
  process.exit(0);
}
if (!/\.(ts|tsx)$/.test(filePath) || filePath.endsWith('d.ts')) {
  process.exit(0);
}
if (filePath.includes('/templates/') || filePath.includes('/generated/')) {
  process.exit(0);
}

/** node_modules/.bin/<name> when it exists, else the bare name off PATH. */
function bin(name) {
  const local = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), 'node_modules/.bin', name);
  return existsSync(local) ? local : name;
}

function cap(text) {
  const out = text.split('\n').slice(0, CAP_LINES).join('\n').slice(0, CAP_CHARS);
  return out.length < text.length ? `${out}\n... (truncated)` : out;
}

// Format (best effort - never block on the formatter).
try {
  execFileSync(bin('oxfmt'), [filePath], { stdio: 'pipe' });
} catch {
  /* oxfmt unavailable or errored - fall through to lint */
}

// Lint the edited file (no --fix). oxlint exits non-zero only on error-severity
// diagnostics - so a freshly introduced import cycle (import/no-cycle) or boundary
// violation is rejected (exit 2) and the capped report is fed back to the agent.
try {
  execFileSync(bin('oxlint'), [filePath], { stdio: 'pipe' });
} catch (e) {
  const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  if (/error/i.test(output)) {
    process.stderr.write(`oxlint reported an error after editing ${filePath}:\n${cap(output)}`);
    process.exit(2);
  }
}
