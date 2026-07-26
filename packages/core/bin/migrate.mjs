#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, parse } from 'node:path';
import { config } from 'dotenv';

const findEnvFile = (from) => {
  const { root } = parse(from);
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (dir === root) {
      return undefined;
    }
  }
};

config({ path: findEnvFile(process.cwd()), quiet: true });

const packageRoot = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', packageRoot), 'utf8'));

const toLabel = (key) =>
  key
    .replace(/^\.\//, '')
    .split('/')
    .filter((segment) => segment !== 'migrate')
    .join('/');

const toEntry = ([key, value]) => ({
  label: toLabel(key),
  url: new URL(
    (typeof value === 'string' ? value : (value.import ?? value.default)).replace(/^\.\//, ''),
    packageRoot,
  ).href,
});

const isMigrateKey = (key) => key.split('/').includes('migrate');
const engineFirst = (a, b) =>
  Number(b.label === 'server') - Number(a.label === 'server') || a.label.localeCompare(b.label);

const sets = Object.entries(manifest.exports)
  .filter(([key]) => isMigrateKey(key))
  .map(toEntry)
  .sort(engineFirst);

for (const { label, url } of sets) {
  process.stdout.write(`\n> migrate ${label}\n`);
  const { migrate } = await import(url);
  await migrate();
}

process.stdout.write(`\nDone: ${sets.length} migration set(s) applied.\n`);
