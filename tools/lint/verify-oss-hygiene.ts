#!/usr/bin/env node
/**
 * OSS hygiene guard. openora is public; a downstream client's internal Jira
 * project key, and a downstream client's or vendor's identity, must never leak
 * into a file name or file content in this repo. Runs in `pnpm verify`.
 * Operates on `git ls-files` (tracked files only), so gitignored paths and
 * build output are excluded by construction.
 *
 * Add a second client key by appending to CLIENT_TICKET_PATTERNS below, or a
 * second client/vendor name by appending to CLIENT_VENDOR_NAME_PATTERNS.
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

// A client's or vendor's name identifies who this platform was built for or against -
// a business relationship this public repo cannot gate on, and a worse leak than a
// ticket id. Content-only: unlike CLIENT_TICKET_PATTERNS this has no path check,
// because an adapter file is conventionally named after the vendor it binds, which is
// the exact pattern OSS consumers are meant to follow.
const CLIENT_VENDOR_NAME_PATTERNS = [
  { key: 'Betfeel', content: /betfeel/gi },
  { key: 'Fireblocks', content: /fireblocks/gi },
] as const;

// Naming a vendor as an illustrative example of what an operator might bind is not the
// same as hardcoding behaviour for one - exempt exactly those spots, and only from
// CLIENT_VENDOR_NAME_PATTERNS. Ticket ids are still checked in these files, and a vendor
// name used anywhere else, including a real binding in a core module, still fails.
const VENDOR_EXAMPLE_EXEMPT_FILES = new Set([
  'packages/core/src/contracts/adapters/kyc.ts',
  'packages/core/src/contracts/schemas/platform-config.ts',
]);
const isVendorExampleExempt = (file: string) =>
  VENDOR_EXAMPLE_EXEMPT_FILES.has(file) || file.startsWith('docs/adapters/');

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

const explainVendorName = (token: string, where: string) =>
  `client/vendor name "${token}" ${where}. Use a generic operator/vendor reference instead; ` +
  'a name that identifies who this was built for or against does not belong in a public repo.';

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
    const vendorExempt = isVendorExampleExempt(file);
    return text.split('\n').flatMap((line, i) => {
      const ticketHits = CLIENT_TICKET_PATTERNS.flatMap((p) =>
        [...line.matchAll(p.content)].map(
          (m) => `  ${file}:${i + 1}: ${explainTicket(m[0], `on line ${i + 1}`)}`,
        ),
      );
      const vendorHits = vendorExempt
        ? []
        : CLIENT_VENDOR_NAME_PATTERNS.flatMap((p) =>
            [...line.matchAll(p.content)].map(
              (m) => `  ${file}:${i + 1}: ${explainVendorName(m[0], `on line ${i + 1}`)}`,
            ),
          );
      return [...ticketHits, ...vendorHits];
    });
  });

const failures = [...pathFailures, ...contentFailures];

if (failures.length > 0) {
  console.error(
    `[FAIL] oss-hygiene: ${failures.length} client ticket/name reference(s):\n${failures.join('\n')}`,
  );
  process.exit(1);
}

console.log(
  `[PASS] oss-hygiene: no client ticket or client/vendor name references across ${trackedFiles.length} tracked files.`,
);
