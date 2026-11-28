#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');

const selfPath = relative(repoRoot, fileURLToPath(import.meta.url));

const CLIENT_TICKET_PATTERNS = [
  {
    key: 'BF',
    path: /bf-?\d+/i,
    content: /\bBF-\d+\b/gi,
  },
] as const;

const CLIENT_VENDOR_NAME_PATTERNS = [
  { key: 'Betfeel', content: /betfeel/gi },
  { key: 'Fireblocks', content: /fireblocks/gi },
] as const;

const VENDOR_EXAMPLE_EXEMPT_FILES = new Set([
  'packages/core/src/contracts/adapters/kyc.ts',
  'packages/core/src/contracts/schemas/platform-config.ts',
]);
const isVendorExampleExempt = (file: string) =>
  VENDOR_EXAMPLE_EXEMPT_FILES.has(file) || file.startsWith('docs/adapters/');

const scannedExtensions = new Set(['.ts', '.tsx', '.md', '.json', '.sql']);
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
