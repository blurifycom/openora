#!/usr/bin/env node
// Ensures every tracked text file ends with a final newline. oxfmt (run first in
// `pnpm format`) already does this for the file types it supports, but it cannot
// format SQL (oxc#20724) and skips a few others; this is the catch-all. Operates on
// `git ls-files` so gitignored paths are excluded by construction; binaries (NUL
// byte) and the lockfile are skipped. Idempotent.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['pnpm-lock.yaml']);

const files = execSync('git ls-files -z', { cwd: root, maxBuffer: 64 * 1024 * 1024 })
  .toString('utf8')
  .split('\0')
  .filter(Boolean);

let fixed = 0;
for (const rel of files) {
  if (SKIP.has(rel)) {
    continue;
  }
  const path = join(root, rel);

  let buf;
  try {
    if (!lstatSync(path).isFile()) {
      continue;
    } // lstat, not stat: skip symlinks/submodules (don't write through a link)
    buf = readFileSync(path);
  } catch {
    continue; // staged-deleted or unreadable
  }

  if (buf.length === 0 || buf.includes(0)) {
    continue;
  } // empty or binary (NUL byte)
  if (buf[buf.length - 1] === 0x0a) {
    continue;
  }

  writeFileSync(path, Buffer.concat([buf, Buffer.from('\n')]));
  console.log(`+ newline: ${rel}`);
  fixed++;
}

console.log(fixed ? `Fixed ${fixed} file(s).` : 'All tracked files already end with a newline.');
