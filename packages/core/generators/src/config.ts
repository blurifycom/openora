import { dirname, join } from 'node:path';
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { PlopTypes } from '@turbo/gen';

// The single generation surface for the platform. ONE Plop engine, ONE template
// dir - used by both the OSS monorepo and downstream consumer repos (a consumer's
// `turbo/generators/config.ts` re-exports this default). Humans run `pnpm gen
// <type> ...`; AI agents call the same via the MCP `scaffold-*` tools. See the
// "How to add ..." sections in AGENTS.md.
//
//   pnpm gen module <domain> <name>  - business module (schema/service/router/plugin)
//   pnpm gen route <module> <M> <p>  - oRPC procedure + contract entry
//   pnpm gen plugin <name>           - overlay plugin
//   pnpm gen adapter <name> <token>  - overlay that rebinds a vendor adapter token
//   pnpm gen config <name>           - operator config schema block
//   pnpm gen event <topic>           - domain event payload in the catalog
//   pnpm gen job-worker <name>       - JOB_QUEUE worker overlay
//   pnpm gen adr <title>             - architecture decision record
//   pnpm gen service <name> <mods>   - thin single-service host (SERVICE_MANIFEST)
//   pnpm gen app <dir>               - downstream consumer repo

// turbo gen bundles this config into a CJS file inside the *consumer* repo, so
// import.meta.url / __dirname point at the consumer, not here, and the .hbs files
// are never copied. Resolve our own install dir through node_modules (the bundle
// is CJS, so `require.resolve` is the real Node resolver) and read templates by
// absolute path.
declare const require: NodeJS.Require;
const pkgDir = dirname(require.resolve('@openora/core/package.json'));
const tpl = (name: string): string => join(pkgDir, 'generators', 'src', 'templates', name);

const kebabRe = /^[a-z][a-z0-9-]*$/;

// Plop hands actions an open `Answers` bag; read fields through these coercers.
type Answers = Record<string, unknown>;
const s = (a: Answers, k: string): string => String(a[k] ?? '');

const toKebab = (v: string): string =>
  v
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
const toCamel = (v: string): string =>
  toKebab(v).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const root = (): string => process.cwd();
// The OSS monorepo owns the core source tree; a consumer repo only has overlays.
const coreSrc = (): string => join(root(), 'packages', 'core', 'src');
const isOssRepo = (): boolean => existsSync(join(coreSrc(), 'contracts'));
// extensions.config.ts lives at the repo root (both OSS and consumer repos).
const extensionsConfigPath = (): string => join(root(), 'extensions.config.ts');
const ossOnly = (gen: string): void => {
  if (!isOssRepo()) {
    throw new Error(
      `'gen ${gen}' is an OSS-core generator and only runs inside the oss monorepo. ` +
        `In a consumer repo, extend via 'gen plugin' / 'gen adapter' overlays instead.`,
    );
  }
};

function registerExtension(id: string, importPath: string): string {
  const file = extensionsConfigPath();
  const line = `  { id: '${id}', path: '${importPath}' },`;
  if (!existsSync(file)) {
    writeFileSync(
      file,
      [
        `// Registered plugins. Order matters - loaded top to bottom.`,
        `export const extensions = [`,
        line,
        `];`,
        ``,
      ].join('\n'),
    );
    return `created ${file}`;
  }
  const src = readFileSync(file, 'utf8');
  if (src.includes(`id: '${id}'`)) {
    return `extensions.config.ts already has '${id}'`;
  }
  writeFileSync(file, src.replace(/(export const extensions = \[)/, `$1\n${line}`));
  return `registered '${id}' in extensions.config.ts`;
}

function appendEventSchema(topic: string): string {
  const file = join(coreSrc(), 'contracts', 'schemas', 'events.ts');
  if (!existsSync(file)) {
    return 'no events.ts (skipped)';
  }
  let src = readFileSync(file, 'utf8');
  if (src.includes(`'${topic}':`)) {
    return `event '${topic}' already in the catalog`;
  }
  const entry = `  '${topic}': z.object({\n    // AGENT: define the payload (ids + primitives)\n  }),`;
  src = src.replace(/(export const domainEventSchemas = \{)/, `$1\n${entry}`);
  writeFileSync(file, src);
  return `added '${topic}' to domainEventSchemas`;
}

const ENGINE_ZONES = new Set(['contracts', 'server', 'react', 'common', 'testing', 'scripts']);

function listDomains(): string[] {
  const src = coreSrc();
  if (!existsSync(src)) {
    return [];
  }
  return readdirSync(src)
    .filter((name) => !ENGINE_ZONES.has(name))
    .filter((name) => existsSync(join(src, name, 'index.ts')))
    .sort();
}

function moduleDir(domain: string, name: string): string {
  return join(coreSrc(), domain, name);
}

/**
 * Appends a `export * as <slice> from ...` (or plugin re-export) line to a domain
 * barrel, creating the barrel when the domain is brand new.
 */
function appendToBarrel(file: string, line: string, header: string): void {
  if (!existsSync(file)) {
    writeFileSync(file, `${header}\n${line}\n`);
    return;
  }
  const src = readFileSync(file, 'utf8');
  if (src.includes(line)) {
    return;
  }
  writeFileSync(file, `${src.replace(/\n*$/, '\n')}${line}\n`);
}

function wireDomainBarrels(domain: string, name: string): string {
  const dir = join(coreSrc(), domain);
  const camel = toCamel(name);
  const contractLine = `export * as ${camel} from './${name}/contract/index.js';`;
  appendToBarrel(
    join(dir, 'index.ts'),
    contractLine,
    `// Public consumer surface of the ${domain} domain - isomorphic contract barrel only.`,
  );
  appendToBarrel(
    join(dir, 'contracts.ts'),
    contractLine,
    `// Contract slices of the ${domain} domain.`,
  );
  appendToBarrel(
    join(dir, 'server.ts'),
    `export { default as ${camel}Plugin } from './${name}/plugin.js';`,
    `// Server surface of the ${domain} domain - plugin entries for the composition root.`,
  );
  return `wired '${name}' into the ${domain} domain barrels`;
}

const SUBPATH_TARGETS = [
  {
    subpath: (d: string, n: string) => `./${d}/contracts/${n}`,
    dist: (d: string, n: string) => `./dist/${d}/${n}/contract/index`,
  },
  {
    subpath: (d: string, n: string) => `./${d}/schema/${n}`,
    dist: (d: string, n: string) => `./dist/${d}/${n}/schema/index`,
  },
  {
    subpath: (d: string, n: string) => `./${d}/plugins/${n}`,
    dist: (d: string, n: string) => `./dist/${d}/${n}/plugin`,
  },
  {
    subpath: (d: string, n: string) => `./${d}/migrate/${n}`,
    dist: (d: string, n: string) => `./dist/${d}/${n}/migrate`,
  },
] as const;

const DOMAIN_TARGETS = [
  { suffix: '', file: 'index' },
  { suffix: '/contracts', file: 'contracts' },
  { suffix: '/server', file: 'server' },
] as const;

/**
 * Adds the module's subpaths to the @openora/core exports map - the package's
 * public surface. `pnpm regen` mirrors them into the tsconfig paths.
 */
function wireCoreExports(domain: string, name: string): string {
  const pkgFile = join(root(), 'packages', 'core', 'package.json');
  const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as {
    exports: Record<string, Record<string, string>>;
  };
  const entry = (dist: string) => ({
    types: `${dist}.d.ts`,
    import: `${dist}.js`,
    default: `${dist}.js`,
  });
  const added: string[] = [];
  const put = (subpath: string, dist: string) => {
    if (pkg.exports[subpath]) {
      return;
    }
    pkg.exports[subpath] = entry(dist);
    added.push(subpath);
  };
  for (const { suffix, file } of DOMAIN_TARGETS) {
    put(`./${domain}${suffix}`, `./dist/${domain}/${file}`);
  }
  for (const { subpath, dist } of SUBPATH_TARGETS) {
    put(subpath(domain, name), dist(domain, name));
  }
  writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`);
  return added.length > 0
    ? `added ${added.length} subpath(s) to @openora/core exports (${added.join(', ')})`
    : 'no new @openora/core exports needed';
}

/**
 * Registers the module's contract slice in the composition root so its routes
 * reach the emitted OpenAPI spec and the typed client.
 */
function wireBuildContract(domain: string, name: string): string {
  const file = join(root(), 'tools', 'gen', 'build-contract.ts');
  if (!existsSync(file)) {
    return 'no tools/gen/build-contract.ts (skipped)';
  }
  const camel = toCamel(name);
  const contractName = `${camel}Contract`;
  let src = readFileSync(file, 'utf8');
  if (src.includes(contractName)) {
    return `build-contract.ts already composes '${camel}'`;
  }
  const importLine = `import { ${contractName} } from '@openora/core/${domain}/contracts/${name}';`;
  src = src.replace(/(\n\n\/\/ oxlint-disable-next-line)/, `\n${importLine}$1`);
  src = src.replace(
    /(const SLICES: Record<string, AnyContract> = \{)/,
    `$1\n  ${camel}: ${contractName},`,
  );
  writeFileSync(file, src);
  return `composed '${camel}' in tools/gen/build-contract.ts`;
}

function appendRoute(
  domain: string,
  moduleName: string,
  method: string,
  routePath: string,
): string {
  const name = toKebab(moduleName);
  const dir = moduleDir(toKebab(domain), name);
  if (!existsSync(dir)) {
    throw new Error(`module '${name}' not found under packages/core/src/${toKebab(domain)}/`);
  }
  const proc = routePath
    .replace(/^\//, '')
    .replace(/\/:(\w+)/g, 'By$1')
    .replace(/[{}]/g, '')
    .replace(/\//g, '.')
    .replace(/[^a-zA-Z0-9.]/g, '');

  const contractFile = join(dir, 'contract', 'index.ts');
  if (existsSync(contractFile)) {
    let c = readFileSync(contractFile, 'utf8');
    const camel = toCamel(name);
    if (!c.includes(`${proc}:`)) {
      const entry = `  ${proc}: oc.route({ method: '${method.toUpperCase()}', path: '${routePath}' }).output(z.object({})),`;
      c = c.replace(new RegExp(`(export const ${camel}Contract = \\{)`), `$1\n${entry}`);
      writeFileSync(contractFile, c);
    }
  }

  const routerFile = join(dir, 'router', 'index.ts');
  let r = readFileSync(routerFile, 'utf8');
  if (!r.includes(`${proc}: os.${proc}`)) {
    const stub = `\n    ${proc}: os.${proc}.handler(() => ({})),`;
    r = r.replace(/(\n\s*\}\);\s*\n\}\s*)$/, `${stub}$1`);
    writeFileSync(routerFile, r);
  }
  return `added '${proc}' (${method.toUpperCase()} ${routePath}) to ${name} - implement the handler/service method, then pnpm regen`;
}

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  plop.setGenerator('module', {
    description: 'New business module under packages/core/src/<domain>/<name>',
    prompts: [
      {
        type: 'input',
        name: 'domain',
        message: `Owning domain (existing: ${listDomains().join(', ')} - or a new kebab-case name):`,
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
      {
        type: 'input',
        name: 'name',
        message: 'Module name (kebab-case):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      ossOnly('module');
      const a = data ?? {};
      const domain = toKebab(s(a, 'domain'));
      const name = toKebab(s(a, 'name'));
      a['domain'] = domain;
      const base = `packages/core/src/${domain}/{{kebabCase name}}`;
      const file = (rel: string, template: string): PlopTypes.ActionType => ({
        type: 'add',
        path: `${base}/${rel}`,
        templateFile: tpl(template),
      });
      return [
        file('contract/index.ts', 'contract.hbs'),
        file('schema/index.ts', 'module/schema.hbs'),
        file('service/{{kebabCase name}}.service.ts', 'module/service.hbs'),
        file('router/index.ts', 'module/router.hbs'),
        file('plugin.ts', 'module/plugin.hbs'),
        file('index.ts', 'module/index.hbs'),
        file('migrate.ts', 'module/migrate.hbs'),
        file('drizzle.config.ts', 'module/drizzle.config.hbs'),
        file('AGENTS.md', 'module/agents.hbs'),
        () => wireDomainBarrels(domain, name),
        () => wireCoreExports(domain, name),
        () => wireBuildContract(domain, name),
        () => registerExtension(name, `./packages/core/dist/${domain}/${name}/plugin.js`),
        () =>
          `next: pnpm gen:drizzle (this module's migration history) && pnpm regen && pnpm verify`,
      ];
    },
  });

  plop.setGenerator('route', {
    description: 'Add an oRPC procedure (contract entry + router handler) to a module',
    prompts: [
      {
        type: 'input',
        name: 'domain',
        message: `Owning domain (${listDomains().join(', ')}):`,
        validate: (v: string) => (v ? true : 'required'),
      },
      {
        type: 'input',
        name: 'module',
        message: 'Module name:',
        validate: (v: string) => (v ? true : 'required'),
      },
      {
        type: 'list',
        name: 'method',
        message: 'HTTP method:',
        choices: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      },
      {
        type: 'input',
        name: 'path',
        message: 'Route path (eg /balance):',
        validate: (v: string) => (v ? true : 'required'),
      },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      ossOnly('route');
      const a = data ?? {};
      return [() => appendRoute(s(a, 'domain'), s(a, 'module'), s(a, 'method'), s(a, 'path'))];
    },
  });

  plop.setGenerator('plugin', {
    description: 'New overlay plugin (routes / providers / event handlers / jobs)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Plugin name (kebab-case):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
    ],
    actions: [
      {
        type: 'add',
        path: 'extensions/{{kebabCase name}}/plugin.ts',
        templateFile: tpl('plugin.hbs'),
      },
      (a: Answers) =>
        registerExtension(toKebab(s(a, 'name')), `./extensions/${toKebab(s(a, 'name'))}/plugin.ts`),
    ],
  });

  plop.setGenerator('adapter', {
    description: 'Overlay that swaps a vendor adapter (rebinds a DI token)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Adapter name (kebab-case, eg stripe-payment):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
      {
        type: 'list',
        name: 'token',
        message: 'Which adapter token does this override?',
        choices: [
          'PAYMENT_ADAPTER',
          'KYC_ADAPTER',
          'NOTIFICATION_DELIVERY_ADAPTER',
          'GEO_IP_ADAPTER',
          'GAME_ADAPTER',
          'AGGREGATOR_ADAPTER',
          'RNG_ADAPTER',
          'SEND_EMAIL',
        ],
      },
      {
        type: 'input',
        name: 'dependsOn',
        message: 'Load after which plugin (owns the default binding)?',
        default: 'wallet',
      },
    ],
    actions: [
      {
        type: 'add',
        path: 'extensions/{{kebabCase name}}/plugin.ts',
        templateFile: tpl('adapter.hbs'),
      },
      (a: Answers) =>
        registerExtension(toKebab(s(a, 'name')), `./extensions/${toKebab(s(a, 'name'))}/plugin.ts`),
    ],
  });

  plop.setGenerator('config', {
    description: 'Operator config schema block (merge into PlatformConfigSchema)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Config name (kebab-case):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
    ],
    actions: (): PlopTypes.ActionType[] => {
      ossOnly('config');
      return [
        {
          type: 'add',
          path: 'packages/core/src/contracts/schemas/config/{{kebabCase name}}.ts',
          templateFile: tpl('config.hbs'),
        },
      ];
    },
  });

  plop.setGenerator('event', {
    description: 'Add a domain event payload to the core contracts catalog',
    prompts: [
      {
        type: 'input',
        name: 'topic',
        message: "Event topic (eg 'wallet.payout.completed'):",
        validate: (v: string) => (/^[a-z][\w.-]+$/.test(v) ? true : 'use <module>.<thing>.<verb>'),
      },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      ossOnly('event');
      const a = data ?? {};
      return [() => appendEventSchema(s(a, 'topic'))];
    },
  });

  plop.setGenerator('job-worker', {
    description: 'Background-job worker overlay (consumes the JOB_QUEUE seam)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Queue / worker name (kebab-case):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
    ],
    actions: [
      {
        type: 'add',
        path: 'extensions/{{kebabCase name}}-worker/plugin.ts',
        templateFile: tpl('job-worker.hbs'),
      },
      (a: Answers) =>
        registerExtension(
          `${toKebab(s(a, 'name'))}-worker`,
          `./extensions/${toKebab(s(a, 'name'))}-worker/plugin.ts`,
        ),
    ],
  });

  plop.setGenerator('adr', {
    description: 'New architecture decision record',
    prompts: [
      {
        type: 'input',
        name: 'title',
        message: 'ADR title:',
        validate: (v: string) => (v ? true : 'required'),
      },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      const a = data ?? {};
      const adrDir = join(root(), 'docs', 'adr');
      const existing = existsSync(adrDir)
        ? readdirSync(adrDir).filter((f) => /^\d{4}-/.test(f))
        : [];
      a['number'] = String(existing.length + 1).padStart(4, '0');
      a['date'] = new Date().toISOString().slice(0, 10);
      return [
        {
          type: 'add',
          path: 'docs/adr/{{number}}-{{kebabCase title}}.md',
          templateFile: tpl('adr.hbs'),
        },
      ];
    },
  });

  plop.setGenerator('service', {
    description: 'Thin single-purpose service host (bakes SERVICE_MANIFEST)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Service name (kebab-case):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
      {
        type: 'input',
        name: 'modules',
        message: 'Module ids (comma-separated):',
        validate: (v: string) => (v ? true : 'required'),
      },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      ossOnly('service');
      const a = data ?? {};
      return [
        () => {
          execFileSync(
            'pnpm',
            ['exec', 'tsx', 'tools/create/create-service.ts', s(a, 'name'), s(a, 'modules')],
            { cwd: root(), stdio: 'inherit' },
          );
          return `created apps/${toKebab(s(a, 'name'))}/ (SERVICE_MANIFEST=${s(a, 'modules')})`;
        },
      ];
    },
  });

  plop.setGenerator('app', {
    description: 'Scaffold a downstream consumer repo (api wired to this checkout)',
    prompts: [
      {
        type: 'input',
        name: 'dir',
        message: 'Target directory (eg ../my-casino):',
        validate: (v: string) => (v ? true : 'required'),
      },
      { type: 'input', name: 'appName', message: 'Project name:', default: '' },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      ossOnly('app');
      const a = data ?? {};
      return [
        () => {
          const args = ['exec', 'tsx', 'tools/create/create-igaming-app.ts', s(a, 'dir')];
          if (s(a, 'appName')) {
            args.push('--name', s(a, 'appName'));
          }
          execFileSync('pnpm', args, { cwd: root(), stdio: 'inherit' });
          return `scaffolded consumer repo at ${s(a, 'dir')}`;
        },
      ];
    },
  });
}
