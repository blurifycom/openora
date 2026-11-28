import { execFileSync, spawnSync } from 'node:child_process';
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

function bin(name) {
  const local = join(process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), 'node_modules/.bin', name);
  return existsSync(local) ? local : name;
}

function cap(text) {
  const out = text.split('\n').slice(0, CAP_LINES).join('\n').slice(0, CAP_CHARS);
  return out.length < text.length ? `${out}\n... (truncated)` : out;
}

spawnSync(bin('oxfmt'), [filePath], { stdio: 'pipe' });

try {
  execFileSync(bin('oxlint'), [filePath], { stdio: 'pipe' });
} catch (e) {
  const output = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  if (/error/i.test(output)) {
    process.stderr.write(`oxlint reported an error after editing ${filePath}:\n${cap(output)}`);
    process.exit(2);
  }
}
