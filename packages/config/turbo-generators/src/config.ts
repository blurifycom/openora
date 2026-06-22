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
//   pnpm gen module <group> <name>   - business module (schema/service/router/plugin)
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
const pkgDir = dirname(require.resolve('@blurifycom/turbo-generators/package.json'));
const tpl = (name: string): string => join(pkgDir, 'src', 'templates', name);

const kebabRe = /^[a-z][a-z0-9-]*$/;
const MODULE_GROUPS = ['player', 'backoffice', 'platform'] as const;

// Plop hands actions an open `Answers` bag; read fields through these coercers.
type Answers = Record<string, unknown>;
const s = (a: Answers, k: string): string => String(a[k] ?? '');

// --- case helpers (JS-side; templates use Handlebars' built-in helpers) -----
const toKebab = (v: string): string =>
  v
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
const toCamel = (v: string): string =>
  toKebab(v).replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());

// --- repo context -----------------------------------------------------------
const root = (): string => process.cwd();
// OSS monorepo has packages/addons; a consumer repo only has overlays.
const isOssRepo = (): boolean => existsSync(join(root(), 'packages', 'addons'));
// extensions.config.ts lives at the OSS root, or under apps/api/src in a consumer.
const extensionsConfigPath = (): string => {
  const ossPath = join(root(), 'extensions.config.ts');
  const consumerPath = join(root(), 'apps', 'api', 'src', 'extensions.config.ts');
  return existsSync(consumerPath) && !existsSync(ossPath) ? consumerPath : ossPath;
};
const ossOnly = (gen: string): void => {
  if (!isOssRepo()) {
    throw new Error(
      `'gen ${gen}' is an OSS-core generator and only runs inside the igaming-oss monorepo. ` +
        `In a consumer repo, extend via 'gen plugin' / 'gen adapter' overlays instead.`,
    );
  }
};

// --- auto-wiring actions ----------------------------------------------------
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
  if (src.includes(`id: '${id}'`)) return `extensions.config.ts already has '${id}'`;
  writeFileSync(file, src.replace(/(export const extensions = \[)/, `$1\n${line}`));
  return `registered '${id}' in extensions.config.ts`;
}

// Add the add-on's schema file to the central drizzle.config glob so its tables
// land in the shared core migration history. Idempotent. Only relevant in the OSS
// monorepo (a consumer has no platform/db drizzle.config).
function registerAddonSchema(name: string): string {
  const file = join(root(), 'packages', 'platform', 'db', 'drizzle.config.ts');
  if (!existsSync(file)) return 'no platform/db drizzle.config.ts (skipped)';
  const line = `    '../../addons/${name}/src/schema/index.ts',`;
  const src = readFileSync(file, 'utf8');
  if (src.includes(`addons/${name}/src/schema/index.ts`)) {
    return `drizzle.config already globs '${name}' schema`;
  }
  // Append before the closing `]` of the `schema: [ ... ]` array.
  const next = src.replace(/(\n\s*\],\n\s*out:)/, `\n${line}$1`);
  if (next === src) return `could not patch drizzle.config (add '${line.trim()}' manually)`;
  writeFileSync(file, next);
  return `globbed '${name}' schema into platform/db drizzle.config.ts`;
}

function wireContractIndex(name: string): string {
  const indexFile = join(root(), 'packages', 'contracts', 'orpc-contract', 'src', 'index.ts');
  if (!existsSync(indexFile)) return 'no orpc-contract index (skipped)';
  let src = readFileSync(indexFile, 'utf8');
  if (src.includes(`from './${name}.js'`)) return `contract index already wires '${name}'`;
  const camel = toCamel(name);
  const contractName = `${camel}Contract`;
  src = src.replace(/(^export\s)/m, `import { ${contractName} } from './${name}.js';\n\n$1`);
  src = src.replace(
    /(^export const contract)/m,
    `export { ${contractName} } from './${name}.js';\n\n$1`,
  );
  src = src.replace(/^(\}\);)/m, `  ${camel}: ${contractName},\n$1`);
  writeFileSync(indexFile, src);
  return `wired '${camel}' into orpc-contract index`;
}

function appendEventSchema(topic: string): string {
  const file = join(root(), 'packages', 'contracts', 'shared-schemas', 'src', 'events.ts');
  if (!existsSync(file)) return 'no events.ts (skipped)';
  let src = readFileSync(file, 'utf8');
  if (src.includes(`'${topic}':`)) return `event '${topic}' already in the catalog`;
  const entry = `  '${topic}': z.object({\n    // AGENT: define the payload (ids + primitives)\n  }),`;
  src = src.replace(/(export const domainEventSchemas = \{)/, `$1\n${entry}`);
  writeFileSync(file, src);
  return `added '${topic}' to domainEventSchemas`;
}

function appendRoute(moduleName: string, method: string, routePath: string): string {
  const name = toKebab(moduleName);
  const moduleDir = join(root(), 'packages', 'addons', name);
  if (!existsSync(moduleDir)) {
    throw new Error(`add-on '${name}' not found under packages/addons/`);
  }
  const proc = routePath
    .replace(/^\//, '')
    .replace(/\/:(\w+)/g, 'By$1')
    .replace(/[{}]/g, '')
    .replace(/\//g, '.')
    .replace(/[^a-zA-Z0-9.]/g, '');

  // 1. contract slice: add a procedure to the `<camel>Contract = { ... }` object
  const contractFile = join(root(), 'packages', 'contracts', 'orpc-contract', 'src', `${name}.ts`);
  if (existsSync(contractFile)) {
    let c = readFileSync(contractFile, 'utf8');
    const camel = toCamel(name);
    if (!c.includes(`${proc}:`)) {
      const entry = `  ${proc}: oc.route({ method: '${method.toUpperCase()}', path: '${routePath}' }).output(z.object({})),`;
      c = c.replace(new RegExp(`(export const ${camel}Contract = \\{)`), `$1\n${entry}`);
      writeFileSync(contractFile, c);
    }
  }

  // 2. router: add `proc: os.proc.handler(() => ({}))` before the router's close
  const routerFile = join(moduleDir, 'src', 'router', 'index.ts');
  let r = readFileSync(routerFile, 'utf8');
  if (!r.includes(`${proc}: os.${proc}`)) {
    const stub = `\n    ${proc}: os.${proc}.handler(() => ({})),`;
    r = r.replace(/(\n\s*\}\);\s*\n\}\s*)$/, `${stub}$1`);
    writeFileSync(routerFile, r);
  }
  return `added '${proc}' (${method.toUpperCase()} ${routePath}) to ${name} - implement the handler/service method, then pnpm regen`;
}

export default function generator(plop: PlopTypes.NodePlopAPI): void {
  // --- module --------------------------------------------------------------
  plop.setGenerator('module', {
    description: 'New business module - a standalone @blurifycom-addons/<name> core add-on package',
    prompts: [
      {
        type: 'list',
        name: 'group',
        // The group no longer maps to a directory (every add-on lives flat under
        // packages/addons/<name>). It is kept purely as descriptive metadata in the
        // generated AGENTS.md / scaffold message.
        message: 'Surface this add-on serves (metadata only):',
        choices: MODULE_GROUPS as unknown as string[],
      },
      {
        type: 'input',
        name: 'name',
        message: 'Add-on name (kebab-case):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      ossOnly('module');
      const a = data ?? {};
      const base = 'packages/addons/{{kebabCase name}}';
      return [
        {
          type: 'add',
          path: `${base}/package.json`,
          templateFile: tpl('module/package.json.hbs'),
        },
        {
          type: 'add',
          path: `${base}/tsconfig.json`,
          templateFile: tpl('module/tsconfig.json.hbs'),
        },
        {
          type: 'add',
          path: `${base}/src/schema/index.ts`,
          templateFile: tpl('module/schema.hbs'),
        },
        {
          type: 'add',
          path: `${base}/src/schemas/index.ts`,
          templateFile: tpl('module/schemas.hbs'),
        },
        {
          type: 'add',
          path: `${base}/src/service/{{kebabCase name}}.service.ts`,
          templateFile: tpl('module/service.hbs'),
        },
        {
          type: 'add',
          path: `${base}/src/router/index.ts`,
          templateFile: tpl('module/router.hbs'),
        },
        { type: 'add', path: `${base}/src/plugin.ts`, templateFile: tpl('module/plugin.hbs') },
        { type: 'add', path: `${base}/src/index.ts`, templateFile: tpl('module/index.hbs') },
        { type: 'add', path: `${base}/AGENTS.md`, templateFile: tpl('module/agents.hbs') },
        {
          type: 'add',
          path: 'packages/contracts/orpc-contract/src/{{kebabCase name}}.ts',
          templateFile: tpl('contract.hbs'),
        },
        // Core add-on: no `kind`, always loaded. Path points at the compiled plugin.
        () =>
          registerExtension(
            toKebab(s(a, 'name')),
            `./packages/addons/${toKebab(s(a, 'name'))}/dist/plugin.js`,
          ),
        () => wireContractIndex(toKebab(s(a, 'name'))),
        () => registerAddonSchema(toKebab(s(a, 'name'))),
        () => 'next: pnpm install (link the new package) && pnpm regen && pnpm verify',
      ];
    },
  });

  // --- route ---------------------------------------------------------------
  plop.setGenerator('route', {
    description: 'Add an oRPC procedure (contract entry + router handler) to a module',
    prompts: [
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
      return [() => appendRoute(s(a, 'module'), s(a, 'method'), s(a, 'path'))];
    },
  });

  // --- plugin (overlay) ----------------------------------------------------
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
        path: 'apps/api/src/extensions/{{kebabCase name}}/plugin.ts',
        templateFile: tpl('plugin.hbs'),
      },
      (a: Answers) =>
        registerExtension(
          toKebab(s(a, 'name')),
          `./apps/api/src/extensions/${toKebab(s(a, 'name'))}/plugin.ts`,
        ),
    ],
  });

  // --- adapter -------------------------------------------------------------
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
        path: 'apps/api/src/extensions/{{kebabCase name}}/plugin.ts',
        templateFile: tpl('adapter.hbs'),
      },
      (a: Answers) =>
        registerExtension(
          toKebab(s(a, 'name')),
          `./apps/api/src/extensions/${toKebab(s(a, 'name'))}/plugin.ts`,
        ),
    ],
  });

  // --- config --------------------------------------------------------------
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
          path: 'packages/contracts/shared-schemas/src/config/{{kebabCase name}}.ts',
          templateFile: tpl('config.hbs'),
        },
      ];
    },
  });

  // --- event ---------------------------------------------------------------
  plop.setGenerator('event', {
    description: 'Add a domain event payload to the shared-schemas catalog',
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

  // --- job-worker ----------------------------------------------------------
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
        path: 'apps/api/src/extensions/{{kebabCase name}}-worker/plugin.ts',
        templateFile: tpl('job-worker.hbs'),
      },
      (a: Answers) =>
        registerExtension(
          `${toKebab(s(a, 'name'))}-worker`,
          `./apps/api/src/extensions/${toKebab(s(a, 'name'))}-worker/plugin.ts`,
        ),
    ],
  });

  // --- adr -----------------------------------------------------------------
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

  // --- service (thin single-module host) -----------------------------------
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
            ['exec', 'tsx', 'tools/create-service.ts', s(a, 'name'), s(a, 'modules')],
            { cwd: root(), stdio: 'inherit' },
          );
          return `created apps/${toKebab(s(a, 'name'))}/ (SERVICE_MANIFEST=${s(a, 'modules')})`;
        },
      ];
    },
  });

  // --- app (downstream consumer repo) --------------------------------------
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
          const args = ['exec', 'tsx', 'tools/create-igaming-app.ts', s(a, 'dir')];
          if (s(a, 'appName')) args.push('--name', s(a, 'appName'));
          execFileSync('pnpm', args, { cwd: root(), stdio: 'inherit' });
          return `scaffolded consumer repo at ${s(a, 'dir')}`;
        },
      ];
    },
  });

  // --- infra (Pulumi AWS deploy) -------------------------------------------
  plop.setGenerator('infra', {
    description: 'Pulumi AWS infra (ECS Fargate + RDS Postgres + ElastiCache Redis + ALB)',
    prompts: [
      {
        type: 'input',
        name: 'name',
        message: 'Project name (kebab-case; used for stacks + resource names):',
        validate: (v: string) => (kebabRe.test(v) ? true : 'use kebab-case'),
      },
      { type: 'input', name: 'region', message: 'AWS region:', default: 'eu-central-1' },
      {
        type: 'input',
        name: 'domainBase',
        message: 'Base domain (eg ss-stage.pl):',
        default: 'ss-stage.pl',
      },
    ],
    actions: (data?: Answers): PlopTypes.ActionType[] => {
      const a = data ?? {};
      const add = (out: string, t: string): PlopTypes.ActionType => ({
        type: 'add',
        path: out,
        templateFile: tpl(t),
      });
      // Scaffolds into apps/infra (covered by the consumer's `apps/*` workspace glob,
      // so no pnpm-workspace.yaml patch is needed). Template sources live under
      // templates/infra/; only the output paths are apps/infra/.
      return [
        add('apps/infra/package.json', 'infra/package.json.hbs'),
        add('apps/infra/tsconfig.json', 'infra/tsconfig.json.hbs'),
        add('apps/infra/Pulumi.yaml', 'infra/Pulumi.yaml.hbs'),
        add('apps/infra/Pulumi.dev.yaml', 'infra/Pulumi.dev.yaml.hbs'),
        add('apps/infra/Pulumi.stage.yaml', 'infra/Pulumi.stage.yaml.hbs'),
        add('apps/infra/index.ts', 'infra/index.ts.hbs'),
        add('apps/infra/src/config.ts', 'infra/src/config.hbs'),
        add('apps/infra/src/network.ts', 'infra/src/network.hbs'),
        add('apps/infra/src/data.ts', 'infra/src/data.hbs'),
        add('apps/infra/src/services.ts', 'infra/src/services.hbs'),
        add('apps/infra/docker/Dockerfile.api', 'infra/docker/Dockerfile.api.hbs'),
        add('apps/infra/docker/Dockerfile.web', 'infra/docker/Dockerfile.web.hbs'),
        add('apps/infra/docker/Dockerfile.backoffice', 'infra/docker/Dockerfile.backoffice.hbs'),
        add('apps/infra/docker/nginx.conf', 'infra/docker/nginx.conf.hbs'),
        add('apps/infra/.gitignore', 'infra/gitignore.hbs'),
        add('apps/infra/README.md', 'infra/README.hbs'),
        () =>
          `next: cd apps/infra && pnpm install, then 'pulumi login s3://<bucket>' and ` +
          `'pulumi stack init ${toKebab(s(a, 'name'))}-dev' (see apps/infra/README.md)`,
      ];
    },
  });
}
