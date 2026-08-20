#!/usr/bin/env node
/**
 * OSS hygiene guard. openora is public; a downstream client's internal Jira
 * project key must never leak into a file name or file content in this repo.
 * Runs in `pnpm verify`.
 * Operates on `git ls-files` (tracked files only), so gitignored paths and
 * build output are excluded by construction.
 *
 * Add a second client key by appending to CLIENT_TICKET_PATTERNS below.
 *
 * Client and vendor NAMES are checked by a sibling pattern list added alongside
 * the change that removes the last hardcoded vendor identifier from core. That
 * rule cannot pass until then, so it ships with the commit that makes it true
 * rather than landing here as a permanently-red check.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

// This file names the forbidden patterns in source, which would otherwise trip
// its own scan - exclude it rather than weaken the patterns.
const selfPath = relative(repoRoot, fileURLToPath(import.meta.url));

const CLIENT_TICKET_PATTERNS = [
  {
    key: 'BF',
    // File paths: no digit boundary requirement, so `bf211` and `bf-211` both
    // match; a word like `BFS` or a hex string (no digit run right after `bf`)
    // does not.
    path: /bf-?\d+/i,
    // File contents: `\b...\b` plus the literal hyphen keeps `BFS-2024` or a
    // hex literal like `0xBF12` (no hyphen) from matching.
    content: /\bBF-\d+\b/gi,
  },
] as const;

const scannedExtensions = new Set(['.ts', '.tsx', '.md', '.json']);
const extname = (file: string) => file.slice(file.lastIndexOf('.'));

const trackedFiles = execSync('git ls-files -z', { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean)
  .filter((file) => file !== selfPath);

const explainTicket = (token: string, where: string) =>
  `client ticket id "${token}" ${where}. Name the file, or describe the behaviour, ` +
  'for what it verifies; ticket ids belong in the commit message and the PR description, not in a public repo.';

const pathFailures = trackedFiles.flatMap((file) => {
  const match = CLIENT_TICKET_PATTERNS.map((p) => file.match(p.path)).find(Boolean);
  return match ? [`  ${file}: ${explainTicket(match[0].toLowerCase(), 'in filename')}`] : [];
});

const contentFailures = trackedFiles
  .filter((file) => scannedExtensions.has(extname(file)))
  .flatMap((file) => {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      return [];
    }
    return text.split('\n').flatMap((line, i) => {
      const ticketHits = CLIENT_TICKET_PATTERNS.flatMap((p) =>
        [...line.matchAll(p.content)].map(
          (m) => `  ${file}:${i + 1}: ${explainTicket(m[0], `on line ${i + 1}`)}`,
        ),
      );
      return ticketHits;
    });
  });

const failures = [...pathFailures, ...contentFailures];

if (failures.length > 0) {
  console.error(
    `[FAIL] oss-hygiene: ${failures.length} client ticket reference(s):\n${failures.join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `[PASS] oss-hygiene: no client ticket references across ${trackedFiles.length} tracked files.`,
);
