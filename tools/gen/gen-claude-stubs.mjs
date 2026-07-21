import { existsSync, globSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STUB = '@AGENTS.md\n';
const noNodeModules = (p) => p.includes('node_modules');

const stubs = globSync('{packages,extensions,apps}/**/AGENTS.md', { exclude: noNodeModules }).map(
  (agentsMd) => join(dirname(agentsMd), 'CLAUDE.md'),
);

for (const stub of stubs) {
  let current;
  try {
    current = readFileSync(stub, 'utf8');
  } catch {
    current = null;
  }
  if (current !== STUB) {
    writeFileSync(stub, STUB);
  }
}

// A deleted/renamed AGENTS.md leaves its gitignored stub behind on every machine -
// remove orphans, but only files that are exactly the generated stub, never hand-written ones.
const orphans = globSync('{packages,extensions,apps}/**/CLAUDE.md', {
  exclude: noNodeModules,
}).filter(
  (stub) => !existsSync(join(dirname(stub), 'AGENTS.md')) && readFileSync(stub, 'utf8') === STUB,
);
orphans.forEach(unlinkSync);

console.log(
  `claude stubs: ${stubs.length} module CLAUDE.md files in sync${orphans.length ? `, ${orphans.length} orphan(s) removed` : ''}`,
);
