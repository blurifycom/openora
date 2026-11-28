#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SKIP = new Set(['pnpm-lock.yaml']);
const SKIP_PATTERNS = [/\/drizzle\/migrations\/.*\.sql$/];

const args = process.argv.slice(2);
const files = args.length
  ? args.map((arg) => relative(root, resolve(arg)))
  : execSync('git ls-files -z', { cwd: root, maxBuffer: 64 * 1024 * 1024 })
      .toString('utf8')
      .split('\0')
      .filter(Boolean);

let fixed = 0;
for (const rel of files) {
  if (SKIP.has(rel) || SKIP_PATTERNS.some((p) => p.test(rel))) {
    continue;
  }
  const path = join(root, rel);

  let buf;
  try {
    if (!lstatSync(path).isFile()) {
      continue;
    }
    buf = readFileSync(path);
  } catch {
    continue;
  }

  if (buf.length === 0 || buf.includes(0)) {
    continue;
  }
  if (buf[buf.length - 1] === 0x0a) {
    continue;
  }

  writeFileSync(path, Buffer.concat([buf, Buffer.from('\n')]));
  console.log(`+ newline: ${rel}`);
  fixed++;
}

const scope = args.length ? `${files.length} file(s)` : 'All tracked files';
console.log(fixed ? `Fixed ${fixed} file(s).` : `${scope} already end with a newline.`);
