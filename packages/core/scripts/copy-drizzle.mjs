import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

const drizzleDirs = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) {
      continue;
    }
    if (name === 'drizzle') {
      drizzleDirs.push(p);
    } else {
      walk(p);
    }
  }
};
if (existsSync(src)) {
  walk(src);
}

for (const from of drizzleDirs) {
  const to = from.replace(`${root}/src/`, `${root}/dist/`);
  cpSync(from, to, { recursive: true });
  console.log(`copied ${from.replace(root + '/', '')} -> ${to.replace(root + '/', '')}`);
}
