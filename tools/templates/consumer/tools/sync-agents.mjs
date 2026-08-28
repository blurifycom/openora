#!/usr/bin/env node
// Render the template-owned agent files from `@openora/create`'s consumer template.
//
// Source of truth: node_modules/@openora/create/template at the pinned @openora/* version
// (with `pnpm link:oss`, ../openora/packages/create-openora's own tools/templates/consumer).
// Runs on `pnpm install` via `prepare`, so these files are generated artifacts: they are
// listed in the managed .gitignore block below and never committed. Only this repo's own
// rules and skills - and the `consumerOwned` overrides in .rulesync/sync.json - are tracked.
//
// To change a synced file, edit openora's tools/templates/consumer and take the next bump.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join, relative, sep } from 'node:path';

const ROOT = process.cwd();
const SYNCED_ROOTS = ['.rulesync/', 'docs/standards/', 'docs/agents/', 'tools/sync-agents.mjs'];
// This script bootstraps `prepare`, so it must stay tracked: ignoring it would leave a
// fresh clone with no way to run the install that would have rendered it.
// Tracked on purpose: `prepare` runs the script, and the Claude hooks in .claude/settings.json
// import _shared.mjs, so both must exist in a fresh clone before the first install.
const NEVER_IGNORED = new Set(['tools/sync-agents.mjs', '.rulesync/hooks/_shared.mjs']);
const SKIPPED_BASENAMES = new Set();

const die = (message) => {
  console.error(`sync:agents - ${message}`);
  process.exit(1);
};

const config = (() => {
  const path = join(ROOT, '.rulesync/sync.json');
  if (!existsSync(path)) {
    die(`${path} is missing - it holds this repo's template variables and consumerOwned list.`);
  }
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    return die(`${path} is not valid JSON: ${err.message}`);
  }
})();
const vars = config.vars ?? {};
const consumerOwned = new Set(config.consumerOwned ?? []);

// The published package ships `template/`; a linked source checkout (pnpm link:oss, CI's
// unbuilt clone) only has the source at tools/templates/consumer - read that directly.
const templateRoot = (() => {
  let pkgDir;
  try {
    pkgDir = dirname(createRequire(join(ROOT, '/')).resolve('@openora/create/package.json'));
  } catch {
    return die('@openora/create is not installed - add it as a devDependency and reinstall.');
  }
  const candidates = [
    join(pkgDir, 'template'),
    join(pkgDir, '..', '..', 'tools', 'templates', 'consumer'),
  ];
  const found = candidates.find((dir) => existsSync(dir));
  if (!found) {
    return die(`consumer template not found at ${candidates.join(' or ')}`);
  }
  return found;
})();

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

const undot = (segment) => (segment.startsWith('__dot__') ? `.${segment.slice(7)}` : segment);

const gitTracked = (paths) => {
  try {
    return execFileSync('git', ['ls-files', '-z', '--', ...paths], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .split('\0')
      .filter(Boolean);
  } catch {
    return [];
  }
};

const substitute = (content) =>
  content.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match);

const render = (file) => {
  const rel = relative(templateRoot, file).split(sep).map(undot).join('/');
  const isTpl = rel.endsWith('.tpl');
  const raw = readFileSync(file, 'utf8');
  return { path: isTpl ? rel.slice(0, -4) : rel, content: isTpl ? substitute(raw) : raw };
};

const rendered = walk(templateRoot)
  .filter((file) => !SKIPPED_BASENAMES.has(file.split(sep).at(-1)))
  .map(render)
  .filter(({ path }) => SYNCED_ROOTS.some((root) => path.startsWith(root)))
  .filter(({ path }) => !consumerOwned.has(path));

// A new template variable must not brick `pnpm install` (which is also how the bump MR that
// would add it gets built) - leave the placeholder in place and say what to add.
const unresolved = rendered.filter(({ content }) => /\{\{\w+\}\}/.test(content));
if (unresolved.length > 0) {
  console.warn(
    'sync:agents - unresolved template variables, add them to .rulesync/sync.json vars:',
  );
  for (const { path, content } of unresolved) {
    console.warn(`  ${path}: ${[...new Set(content.match(/\{\{\w+\}\}/g))].join(' ')}`);
  }
}

// Tracking a path is how this repo says "mine": .gitignore does not apply to it, so writing
// would replace the committed content and leave a permanently dirty file. Skip those and
// name them - opting one into being generated is a deliberate `git rm --cached`.
const trackedPaths = new Set(gitTracked(rendered.map(({ path }) => path)));
const owned = rendered.filter(({ path }) => trackedPaths.has(path) && !NEVER_IGNORED.has(path));

for (const { path, content } of rendered) {
  if (trackedPaths.has(path) && !NEVER_IGNORED.has(path)) {
    continue;
  }
  const target = join(ROOT, path);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target) || readFileSync(target, 'utf8') !== content) {
    writeFileSync(target, content);
  }
}

// Git must ignore exactly what this script writes, so a template that gains or loses a
// file cannot leave an untracked stray behind. The block is rewritten in place; anything
// outside the markers is left alone.
const BEGIN = '# BEGIN synced-agents (generated by tools/sync-agents.mjs - do not edit)';
const END = '# END synced-agents';
const gitignore = join(ROOT, '.gitignore');
// A tracked path is never ignored by git anyway - listing it would only mislead.
const ignored = rendered.filter(({ path }) => !NEVER_IGNORED.has(path) && !trackedPaths.has(path));
const block = [BEGIN, ...ignored.map(({ path }) => `/${path}`).sort(), END].join('\n');
const current = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
const start = current.indexOf(BEGIN);
// Search for END after BEGIN: a stray END earlier in the file (hand-edit, bad merge) would
// otherwise splice at a negative offset and duplicate the whole block.
const end = start === -1 ? -1 : current.indexOf(END, start + BEGIN.length);
if (start !== -1 && end === -1) {
  die(`${gitignore} has a ${BEGIN} marker with no matching ${END} - repair or delete the block.`);
}
const updated =
  start === -1
    ? `${current.trimEnd()}\n\n${block}\n`.trimStart()
    : current.slice(0, start) + block + current.slice(end + END.length);
if (updated !== current) {
  writeFileSync(gitignore, updated);
}

console.log(`sync:agents - ${rendered.length - owned.length} template-owned file(s) rendered.`);
if (owned.length > 0) {
  console.warn(
    `  ${owned.length} kept as-is because this repo tracks them: ${owned.map(({ path }) => path).join(', ')}\n` +
      `  To let the template own one, untrack it: git rm --cached <path>`,
  );
}
