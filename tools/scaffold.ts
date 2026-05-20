#!/usr/bin/env node
/**
 * Code-mod scaffolder. Called by slash commands, pnpm scripts, and the MCP dev server.
 *
 * Usage:
 *   pnpm scaffold module <name>
 *   pnpm scaffold plugin <name>
 *   pnpm scaffold route <module> <method> <path>
 *   pnpm scaffold ui-component <Name>
 *   pnpm scaffold adr <title>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const [, , type, ...args] = process.argv;

const scaffolders: Record<string, (...args: string[]) => void> = {
  module: scaffoldModule,
  plugin: scaffoldPlugin,
  route: scaffoldRoute,
  'ui-component': scaffoldUiComponent,
  adr: scaffoldAdr,
};

const fn = scaffolders[type ?? ''];
if (!fn) {
  console.error(`Unknown scaffold type: ${type}`);
  console.error(`Available: ${Object.keys(scaffolders).join(', ')}`);
  process.exit(1);
}

fn(...args);

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------
function scaffoldModule(rawName?: string) {
  if (!rawName) die('Usage: pnpm scaffold module <name>');

  const name = toKebab(rawName);
  const Name = toPascal(name);
  const NAME_UPPER = name.replace(/-/g, '_').toUpperCase();
  const dest = join(repoRoot, 'packages', 'modules', name);

  if (existsSync(dest)) die(`packages/modules/${name} already exists`);

  const tmpl = join(here, 'templates', 'module');
  const vars = { name, Name, NAME_UPPER };

  copyTemplate(tmpl, dest, vars);

  // Create nested dirs for service file named after the module
  renameTemplateFiles(dest, vars);

  // Register in extensions.config.ts
  appendExtensionConfig(name);

  console.log(`- module @oss/module-${name} created at packages/modules/${name}/`);
  console.log(`- registered in extensions.config.ts`);
  console.log(`- next: pnpm regen && pnpm verify`);
}

// ---------------------------------------------------------------------------
// Plugin (overlay)
// ---------------------------------------------------------------------------
function scaffoldPlugin(rawName?: string) {
  if (!rawName) die('Usage: pnpm scaffold plugin <name>');

  const name = toKebab(rawName);
  const Name = toPascal(name);
  const dest = join(repoRoot, 'apps', 'extensions', name);

  if (existsSync(dest)) die(`apps/extensions/${name} already exists`);
  mkdirSync(dest, { recursive: true });

  const tmpl = join(here, 'templates', 'plugin');
  copyTemplate(tmpl, dest, { name, Name });

  appendExtensionConfig(name, { isOverlay: true });

  console.log(`- overlay extension created at apps/extensions/${name}/`);
  console.log(`- registered in extensions.config.ts`);
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------
function scaffoldRoute(moduleName?: string, method?: string, routePath?: string) {
  if (!moduleName || !method || !routePath) {
    die('Usage: pnpm scaffold route <module> <GET|POST|PUT|PATCH|DELETE> <path>');
  }

  const name = toKebab(moduleName);
  const routerFile = join(repoRoot, 'packages', 'modules', name, 'src', 'router', 'index.ts');
  if (!existsSync(routerFile)) die(`Module ${name} not found at packages/modules/${name}`);

  const procedureName = pathToProcedureName(routePath);
  const stub = `
  // TODO: implement ${method.toUpperCase()} ${routePath}
  ${procedureName}: os
    .input(z.object({ /* define input */ }))
    .output(z.object({ /* define output */ }))
    .handler(async ({ input, context }) => {
      throw new Error('not implemented');
    }),`;

  let src = readFileSync(routerFile, 'utf8');
  // append before last closing brace of router definition if found
  if (src.includes('.router({')) {
    src = src.replace(/(\}\);?\s*)$/, `${stub}\n$1`);
  } else {
    src += `\n// Route stub for ${method.toUpperCase()} ${routePath}:\n${stub}\n`;
  }
  writeFileSync(routerFile, src);

  console.log(
    `- route stub ${procedureName} added to packages/modules/${name}/src/router/index.ts`,
  );
  console.log(`- implement the handler in service/${name}.service.ts`);
}

// ---------------------------------------------------------------------------
// UI Component
// ---------------------------------------------------------------------------
function scaffoldUiComponent(rawName?: string) {
  if (!rawName) die('Usage: pnpm scaffold ui-component <Name>');

  const Name = toPascal(rawName);
  const name = toKebab(rawName);

  // Contract entry
  const contractDir = join(repoRoot, 'packages', 'ui', 'provider-contract', 'src', 'components');
  mkdirSync(contractDir, { recursive: true });
  const contractFile = join(contractDir, `${name}.ts`);
  if (!existsSync(contractFile)) {
    writeFileSync(
      contractFile,
      [
        `import type { ComponentType, HTMLAttributes } from 'react';`,
        ``,
        `export interface ${Name}Props extends HTMLAttributes<HTMLDivElement> {`,
        `  // define props`,
        `}`,
        ``,
        `export type ${Name}Component = ComponentType<${Name}Props>;`,
        ``,
      ].join('\n'),
    );
  }

  // Shadcn impl stub
  const implDir = join(repoRoot, 'packages', 'ui', 'provider-shadcn', 'src', 'components');
  mkdirSync(implDir, { recursive: true });
  const implFile = join(implDir, `${name}.tsx`);
  if (!existsSync(implFile)) {
    writeFileSync(
      implFile,
      [
        `'use client';`,
        `import type { ${Name}Props } from '@oss/ui-provider-contract';`,
        ``,
        `export function ${Name}({ className, ...props }: ${Name}Props) {`,
        `  return <div className={className} {...props} />;`,
        `}`,
        ``,
      ].join('\n'),
    );
  }

  // Storybook story
  const storyDir = join(repoRoot, 'apps', 'storybook', 'stories');
  mkdirSync(storyDir, { recursive: true });
  const storyFile = join(storyDir, `${name}.stories.tsx`);
  if (!existsSync(storyFile)) {
    writeFileSync(
      storyFile,
      [
        `import type { Meta, StoryObj } from '@storybook/react';`,
        `import { ${Name} } from '@oss/ui-provider-shadcn';`,
        ``,
        `const meta: Meta<typeof ${Name}> = { component: ${Name} };`,
        `export default meta;`,
        ``,
        `export const Default: StoryObj<typeof ${Name}> = { args: {} };`,
        ``,
      ].join('\n'),
    );
  }

  console.log(`- contract: packages/ui/provider-contract/src/components/${name}.ts`);
  console.log(`- shadcn impl: packages/ui/provider-shadcn/src/components/${name}.tsx`);
  console.log(`- story: apps/storybook/stories/${name}.stories.tsx`);
}

// ---------------------------------------------------------------------------
// ADR
// ---------------------------------------------------------------------------
function scaffoldAdr(rawTitle?: string) {
  if (!rawTitle) die('Usage: pnpm scaffold adr <title>');

  const adrDir = join(repoRoot, 'docs', 'adr');
  mkdirSync(adrDir, { recursive: true });

  const existing = readdirSync(adrDir)
    .filter((f) => /^\d{4}-/.test(f))
    .sort();
  const nextNum = existing.length + 1;
  const number = String(nextNum).padStart(4, '0');
  const slug = toKebab(rawTitle);
  const file = join(adrDir, `${number}-${slug}.md`);
  const date = new Date().toISOString().slice(0, 10);

  const tmpl = readTpl(join(here, 'templates', 'adr', 'NNNN-title.md.tpl'));
  const content = interpolate(tmpl, {
    number,
    Title: toPascal(rawTitle)
      .replace(/([A-Z])/g, ' $1')
      .trim(),
    date,
  });
  writeFileSync(file, content);
  console.log(`- ADR created: docs/adr/${number}-${slug}.md`);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function copyTemplate(src: string, dest: string, vars: Record<string, string>) {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    if (statSync(srcPath).isDirectory()) {
      const destDir = join(dest, interpolate(entry, vars));
      copyTemplate(srcPath, destDir, vars);
    } else {
      const destFile = join(dest, interpolate(entry, vars).replace(/\.tpl$/, ''));
      const content = interpolate(readTpl(srcPath), vars);
      writeFileSync(destFile, content);
    }
  }
}

function renameTemplateFiles(dir: string, vars: Record<string, string>) {
  // Templates use {{name}} in filename - already resolved by copyTemplate interpolate
  // This is a no-op but kept for clarity
}

function readTpl(p: string): string {
  return readFileSync(p, 'utf8');
}

function interpolate(str: string, vars: Record<string, string>): string {
  return str.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function appendExtensionConfig(name: string, opts?: { isOverlay?: boolean }) {
  const configFile = join(repoRoot, 'extensions.config.ts');
  const overlay = opts?.isOverlay ?? false;
  const line = overlay
    ? `  { id: '${name}', path: './apps/extensions/${name}/plugin.ts' },`
    : `  { id: '${name}', path: './packages/modules/${name}/src/plugin.ts' },`;

  if (!existsSync(configFile)) {
    writeFileSync(
      configFile,
      [
        `// Registered plugins. Order matters - loaded top to bottom.`,
        `// Each entry's 'register()' runs at API boot via packages/platform/plugin-host.`,
        `export const extensions = [`,
        line,
        `];`,
        ``,
      ].join('\n'),
    );
  } else {
    let src = readFileSync(configFile, 'utf8');
    if (src.includes(line)) return;
    src = src.replace(/(export const extensions = \[)/, `$1\n${line}`);
    writeFileSync(configFile, src);
  }
}

function pathToProcedureName(p: string): string {
  return p
    .replace(/^\//, '')
    .replace(/\/:(\w+)/g, 'By$1')
    .replace(/\//g, '.')
    .replace(/[^a-zA-Z0-9.]/g, '');
}

function toKebab(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
}

function toPascal(s: string): string {
  return toKebab(s)
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
