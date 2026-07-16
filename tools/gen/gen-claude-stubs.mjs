import { globSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const STUB = '@AGENTS.md\n';

const stubs = globSync('{packages,extensions,apps}/**/AGENTS.md', {
  exclude: (p) => p.includes('node_modules') || p.includes('/templates/'),
}).map((agentsMd) => join(dirname(agentsMd), 'CLAUDE.md'));

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

console.log(`claude stubs: ${stubs.length} module CLAUDE.md files in sync`);
