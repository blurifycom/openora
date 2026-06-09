#!/usr/bin/env node
/**
 * Scaffold a thin host app for a single microservice: apps/<name>/, which boots a
 * SUBSET of the platform's modules (a service manifest) from the SAME codebase.
 * The module logic is NOT copied - the host reuses the root extensions.config.ts
 * and filters it to the chosen modules, so there is one source of truth per module
 * whether it runs in the monolith or as its own service.
 *
 * Usage:
 *   pnpm create:service <name> <module,module,...>
 *   pnpm create:service wallet identity,wallet
 *
 * After scaffolding: `pnpm install`, build deps, then
 *   pnpm -F @oss/<name>-service dev          # uses the baked-in manifest
 *   SERVICE_MANIFEST=identity,wallet,bonus pnpm -F @oss/<name>-service dev   # override
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const [, , rawName, rawManifest] = process.argv;
if (!rawName || !rawManifest) {
  console.error('Usage: pnpm create:service <name> <module,module,...>');
  console.error('Example: pnpm create:service wallet identity,wallet');
  process.exit(1);
}

const name = rawName.toLowerCase();
if (!/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error(`Invalid service name "${rawName}". Use lowercase letters, digits, and dashes.`);
  process.exit(1);
}
const manifest = rawManifest
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// Validate the chosen modules against the registry so a typo fails here, not at boot.
const configSrc = readFileSync(join(repoRoot, 'extensions.config.ts'), 'utf8');
const knownIds = [...configSrc.matchAll(/id:\s*'([^']+)'/g)].map((m) => m[1]);
const unknown = manifest.filter((m) => !knownIds.includes(m));
if (unknown.length > 0) {
  console.error(`Unknown module id(s): ${unknown.join(', ')}.\nKnown: ${knownIds.join(', ')}`);
  process.exit(1);
}

const appDir = join(repoRoot, 'apps', name);
if (existsSync(appDir)) {
  console.error(`apps/${name} already exists.`);
  process.exit(1);
}

const pkgName = `@oss/${name}-service`;

// Reuse the api host's manifest-aware extensions loader verbatim, so the module
// list stays single-sourced in the root extensions.config.ts.
const extensionsLoader = readFileSync(join(repoRoot, 'apps/api/src/extensions.ts'), 'utf8');

const files: Record<string, string> = {
  'package.json':
    JSON.stringify(
      {
        name: pkgName,
        version: '0.0.1',
        private: true,
        type: 'module',
        scripts: {
          build: 'tsc',
          dev: 'node --import tsx --watch src/main.ts',
          start: 'node dist/main.js',
          typecheck: 'tsc --noEmit',
        },
        dependencies: {
          '@orpc/server': '1.14.3',
          '@oss/adapters': 'workspace:*',
          '@oss/api-runtime': 'workspace:*',
          '@oss/core': 'workspace:*',
          '@oss/orpc-contract': 'workspace:*',
          '@oss/plugin-host': 'workspace:*',
          '@oss/shared-schemas': 'workspace:*',
          amqplib: '^2.0.1',
          bullmq: '^5.77.6',
          zod: '4.4.3',
        },
        devDependencies: {
          '@oss/modules': 'workspace:*',
          '@oss/tsconfig': 'workspace:*',
          tsx: '4.22.2',
          typescript: '6.0.3',
        },
      },
      null,
      2,
    ) + '\n',

  'tsconfig.json':
    JSON.stringify(
      {
        extends: '@oss/tsconfig/node-service.json',
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',

  'src/extensions.ts': extensionsLoader,

  'src/main.ts': `import { createApp } from '@oss/api-runtime';
import { contract } from '@oss/orpc-contract';
import { loadExtensions } from './extensions.js';

// ${name} service: boots only the modules it owns. The module code is shared with
// the monolith (root extensions.config.ts) - this host just narrows it via the
// SERVICE_MANIFEST seam. Override the default at runtime with SERVICE_MANIFEST.
process.env['SERVICE_MANIFEST'] ??= '${manifest.join(',')}';

async function bootstrap() {
  const plugins = await loadExtensions();
  const { listen } = await createApp({ plugins, contract });
  await listen();
}

bootstrap();
`,
};

mkdirSync(join(appDir, 'src'), { recursive: true });
for (const [rel, content] of Object.entries(files)) {
  const dest = join(appDir, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, content, 'utf8');
}

console.log(`Created apps/${name} (${pkgName}) booting modules: ${manifest.join(', ')}`);
console.log('Next:');
console.log('  pnpm install');
console.log(`  pnpm -F ${pkgName} dev        # boots the baked-in manifest`);
console.log(`  SERVICE_MANIFEST=... pnpm -F ${pkgName} dev   # override at runtime`);
console.log('To exclude these modules from the monolith, drop them from extensions.config.ts');
console.log(
  'and run them only via this host (events flow once a durable broker is set: AMQP_URL).',
);
