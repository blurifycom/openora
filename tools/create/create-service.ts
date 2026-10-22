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
 *
 * Run without arguments, it prints an example that boots (service-example.json, which an E2E
 * boots too). The manifest lists every module its modules depend on, every module that binds a
 * port they require, and every module behind a control they would otherwise skip
 * (`controlPorts`, AdminGuard's); a boot that misses any prints one manifest line adding all of
 * them. The host bakes the service name as its SERVICE_NAME - its own Redis Streams consumer
 * group.
 *
 * After scaffolding: `pnpm install`, build deps, then
 *   pnpm -F @openora/<name>-service dev          # uses the baked-in manifest
 *   SERVICE_MANIFEST=<module,...> pnpm -F @openora/<name>-service dev   # override
 */
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../..');
const example = JSON.parse(
  readFileSync(join(repoRoot, 'tools/create/service-example.json'), 'utf8'),
) as { name: string; manifest: string[] };

const [, , rawName, rawManifest] = process.argv;
if (!rawName || !rawManifest) {
  console.error('Usage: pnpm create:service <name> <module,module,...>');
  console.error(`Example: pnpm create:service ${example.name} ${example.manifest.join(',')}`);
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

const pkgName = `@openora/${name}-service`;

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
          'check:types': 'tsc --noEmit',
        },
        dependencies: {
          '@openora/core': 'workspace:*',
        },
        devDependencies: {
          tsx: '4.23.1',
          typescript: '6.0.3',
        },
      },
      null,
      2,
    ) + '\n',

  'tsconfig.json':
    JSON.stringify(
      {
        extends: '@openora/core/tsconfig/node-service.json',
        compilerOptions: { rootDir: 'src', outDir: 'dist' },
        include: ['src'],
      },
      null,
      2,
    ) + '\n',

  'src/main.ts': `import { createApp, loadExtensions } from '@openora/core/server';
import { user, session, account, verification, twoFactor } from '@openora/core/pam/schema/identity';

// ${name} service: boots only the modules it owns. The module code is shared with
// the monolith (root extensions.config.ts) - createApp narrows it via the
// SERVICE_MANIFEST seam. Override the defaults at runtime with SERVICE_MANIFEST and
// SERVICE_NAME; the name is this service's own consumer group.
process.env['SERVICE_MANIFEST'] ??= '${manifest.join(',')}';
process.env['SERVICE_NAME'] ??= '${name}';

async function bootstrap() {
  const plugins = await loadExtensions();
  // Routes come from the loaded plugins; createApp exposes runtime API docs.
  const { listen } = await createApp({
    plugins,
    authSchema: { user, session, account, verification, twoFactor },
  });
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
console.log(
  `  DATABASE_URL=... REDIS_URL=... CORS_ORIGINS=... pnpm -F ${pkgName} dev   # boots the baked-in manifest`,
);
console.log(`  SERVICE_MANIFEST=... pnpm -F ${pkgName} dev   # override at runtime`);
console.log('To exclude these modules from the monolith, drop them from extensions.config.ts');
console.log(
  'and run them only via this host (set REDIS_URL or bind MESSAGE_BROKER in an overlay; AMQP_URL only enables the outbox).',
);
console.warn('Before you deploy it:');
console.warn(
  '  - A module this service and another process both load handles each event in both, under each',
);
console.warn(
  '    SERVICE_NAME - audit writes every row twice. Until ADR-0047 lands, split modules no other process loads.',
);
console.warn(
  '  - A manifest that leaves out a module behind a control (RG limits, country checks, audit',
);
console.warn(
  '    records, admin grants) refuses to boot and prints one manifest line with every module to',
);
console.warn(
  '    add. Every split loads iam and identity for AdminGuard, and identity brings compliance,',
);
console.warn(
  '    which depends on wallet, gaming, player-management and exchange-rate: about ten modules.',
);
console.warn(
  '  - The boot logs each other optional port the manifest leaves unbound and what its module',
);
console.warn('    skips without it. Read those lines.');
