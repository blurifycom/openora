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

if (!filePath) {
  process.exit(0);
}

if (!/\.(ts|tsx)$/.test(filePath) || filePath.endsWith('d.ts')) {
  process.exit(0);
}

if (filePath.includes('/templates/') || filePath.includes('/generated/')) {
  process.exit(0);
}

// Format (best effort - never block on the formatter).
try {
  execSync(`pnpm exec oxfmt "${filePath}"`, { stdio: 'pipe' });
} catch {
  /* oxfmt unavailable or errored - fall through to lint */
}

// Lint the edited file (no --fix). oxlint exits non-zero only on error-severity
// diagnostics - so a freshly introduced import cycle (import/no-cycle) or boundary
// violation is rejected (exit 2) and the capped report is fed back to the agent.
let lintOutput = '';

try {
  lintOutput = execSync(`pnpm exec oxlint "${filePath}"`, { stdio: 'pipe' }).toString();
} catch (e) {
  const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');

  if (/error/i.test(output)) {
    process.stderr.write(`oxlint reported an error after editing ${filePath}:\n${cap(output)}`);
    process.exit(2);
  }

  lintOutput = output;
}

// oxlint exits 0 on warnings, so the block above never sees them - which left
// every rule still ramping at `warn` invisible while code was being written, and
// discoverable only in a full lint run after the fact. Feed them back as context
// instead: informative, not blocking, so a rule mid-ramp can still teach without
// failing the edit. Claude reads `additionalContext`; the other CLIs read the
// exit code and ignore this line.
const warnings = lintOutput
  .split('\n')
  .filter((line) => line.includes('warning anti-slop('))
  .slice(0, 10);

if (warnings.length > 0) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PostToolUse',
        additionalContext:
          `anti-slop warnings in ${filePath} - these enforce docs/standards/types.md ` +
          `and testing.md. Fix them now if the code you just wrote caused them; ` +
          `leave pre-existing ones alone.\n${cap(warnings.join('\n'))}`,
      },
    }),
  );
}

// Resolve the owning workspace package (apps/<x> or packages/<group>/<x>).
function packageNameFor(fp) {
  const m = fp.match(/(.*?\/(?:apps\/[^/]+|packages\/[^/]+\/[^/]+))\//);

  if (!m) {
    return null;
  }

  try {
    const pkg = JSON.parse(readFileSync(join(m[1], 'package.json'), 'utf8'));

    if (!pkg.name || !pkg.scripts?.typecheck) {
      return null;
    }

    return pkg.name;
  } catch {
    return null;
  }
}

const abs = isAbsolute(filePath) ? filePath : join(process.cwd(), filePath);

const owner = packageNameFor(abs);

if (!owner) {
  process.exit(0);
}

function cap(text) {
  const out = text.split('\n').slice(0, CAP_LINES).join('\n').slice(0, CAP_CHARS);

  return out.length < text.length ? `${out}\n... (truncated)` : out;
}

try {
  execSync(`pnpm --filter "${owner}" typecheck`, { stdio: 'pipe' });
  process.exit(0);
} catch (e) {
  const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');

  const basename =
    (isAbsolute(filePath) ? relative(process.cwd(), filePath) : filePath).split('/').pop() ?? '';

  if (basename && output.includes(basename)) {
    process.stderr.write(
      `Typecheck failed for ${owner} after editing ${basename}:\n${cap(output)}`,
    );
    process.exit(2);
  }

  process.exit(0);
}
