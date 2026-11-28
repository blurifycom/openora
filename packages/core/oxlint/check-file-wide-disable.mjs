#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { matchesGlob } from 'node:path';

const SOURCE_FILES = ['*.ts', '*.tsx', '*.mts', '*.cts', '*.js', '*.jsx', '*.mjs', '*.cjs'];
const FILE_WIDE_DISABLE = /\/\*\s*(eslint|oxlint)-disable\s*\*\//;

const ignorePatterns = existsSync('.oxlintrc.json')
  ? (JSON.parse(readFileSync('.oxlintrc.json', 'utf8')).ignorePatterns ?? [])
  : [];
const isIgnored = (file) =>
  ignorePatterns.some((pattern) =>
    [pattern, `${pattern}/**`, `**/${pattern}`, `**/${pattern}/**`].some((glob) =>
      matchesGlob(file, glob),
    ),
  );

const offenders = execFileSync('git', ['ls-files', '-z', '--', ...SOURCE_FILES], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter((file) => file && existsSync(file) && !isIgnored(file))
  .filter((file) => FILE_WIDE_DISABLE.test(readFileSync(file, 'utf8')));

if (offenders.length) {
  process.stderr.write(
    `A file-wide lint disable turns off every rule in the file. Name the rules it disables:\n${offenders.map((file) => `  ${file}`).join('\n')}\n`,
  );
  process.exit(1);
}
