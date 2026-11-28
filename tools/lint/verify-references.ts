#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '../..');

const CONSUMER_SCRIPTS = new Set(['link:oss', 'unlink:oss', 'oss:worktree', 'sync:agents']);

const PNPM_BUILTINS = new Set(['install', 'exec', 'run', 'dlx', 'add', 'remove', 'why', 'setup']);

const CHECKED_PATH_ROOTS = ['packages/', 'tools/', '.rulesync/', 'docs/'];

const DESCRIBES_ANOTHER_REPO = new Set(['docs/guides/downstream-consumer.md']);

type Violation = { file: string; line: number; message: string };
const violations: Violation[] = [];

const report = (file: string, index: number, message: string) =>
  violations.push({ file, line: index + 1, message });

const trackedFiles = execSync('git ls-files -z', { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 })
  .toString()
  .split('\0')
  .filter(Boolean);

const markdownFiles = trackedFiles.filter(
  (file) => file.endsWith('.md') && !file.endsWith('.md.tpl'),
);

const packageScripts = new Set(
  Object.keys(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).scripts ?? {}),
);

const binaries = new Set(
  existsSync(join(repoRoot, 'node_modules/.bin'))
    ? readdirSync(join(repoRoot, 'node_modules/.bin'))
    : [],
);

const rosterAgents = new Set(
  readdirSync(join(repoRoot, '.rulesync/subagents')).map((file) => file.replace(/\.md$/, '')),
);

const headingSlug = (heading: string) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');

const anchorsOf = (absolutePath: string) =>
  new Set(
    readFileSync(absolutePath, 'utf8')
      .split('\n')
      .filter((line) => line.startsWith('#'))
      .map((line) => headingSlug(line.replace(/^#+\s*/, ''))),
  );

const MARKDOWN_LINK = /\[[^\]]*\]\(([^)\s]+)\)/g;
const BACKTICK_PATH = /`([\w./-]+\/[\w./-]*)`/g;
const PNPM_SCRIPT = /`?pnpm ([a-z][\w:-]*)/g;
const ROSTER_MENTION = /`([a-z-]+)`\s*(?:\(|subagent|agent)/g;

const checkLinks = (file: string, lines: string[]) => {
  const fileDir = dirname(join(repoRoot, file));

  lines.forEach((line, index) => {
    for (const [, target] of line.matchAll(MARKDOWN_LINK)) {
      if (/^(https?:|mailto:|#|\/)/.test(target)) {
        continue;
      }

      const [path, anchor] = target.split('#');
      const absolutePath = resolve(fileDir, path);

      if (!existsSync(absolutePath)) {
        report(file, index, `link target does not exist: ${target}`);
        continue;
      }

      if (anchor && absolutePath.endsWith('.md') && !anchorsOf(absolutePath).has(anchor)) {
        report(file, index, `link anchor not found in ${path}: #${anchor}`);
      }
    }
  });
};

const checkBacktickPaths = (file: string, lines: string[]) => {
  if (DESCRIBES_ANOTHER_REPO.has(file)) {
    return;
  }

  lines.forEach((line, index) => {
    for (const [, path] of line.matchAll(BACKTICK_PATH)) {
      if (/[<{*|]/.test(path)) {
        continue;
      }
      if (!CHECKED_PATH_ROOTS.some((root) => path.startsWith(root))) {
        continue;
      }
      if (!existsSync(join(repoRoot, path))) {
        report(file, index, `path does not exist: ${path}`);
      }
    }
  });
};

const checkPnpmScripts = (file: string, lines: string[]) => {
  lines.forEach((line, index) => {
    for (const [, script] of line.matchAll(PNPM_SCRIPT)) {
      if (PNPM_BUILTINS.has(script) || CONSUMER_SCRIPTS.has(script)) {
        continue;
      }
      if (packageScripts.has(script) || binaries.has(script)) {
        continue;
      }
      report(file, index, `pnpm script does not exist: pnpm ${script}`);
    }
  });
};

const checkRosterMentions = (file: string, lines: string[]) => {
  const rosterSection = lines.findIndex((line) => /^#+\s*The roster/i.test(line));
  if (rosterSection === -1) {
    return;
  }

  lines.slice(rosterSection).forEach((line, offset) => {
    for (const [, name] of line.matchAll(ROSTER_MENTION)) {
      if (rosterAgents.has(name)) {
        continue;
      }
      report(file, rosterSection + offset, `roster names an agent with no subagent file: ${name}`);
    }
  });
};

const checkFrontmatter = (file: string, lines: string[]) => {
  if (lines[0] !== '---') {
    report(file, 0, 'missing frontmatter');
    return;
  }

  const end = lines.indexOf('---', 1);
  const frontmatter = lines.slice(1, end === -1 ? lines.length : end);

  for (const key of ['name', 'description']) {
    if (!frontmatter.some((line) => line.startsWith(`${key}:`))) {
      report(file, 0, `frontmatter missing ${key}`);
    }
  }

  const declaredName = frontmatter
    .find((line) => line.startsWith('name:'))
    ?.slice('name:'.length)
    .trim();
  const directoryName = file.split('/').at(-2);

  if (declaredName && declaredName !== directoryName) {
    report(file, 0, `skill name "${declaredName}" does not match directory "${directoryName}"`);
  }
};

const checkAdrNumbering = () => {
  const adrFiles = readdirSync(join(repoRoot, 'docs/adr')).filter((file) => file.endsWith('.md'));
  const byNumber = new Map<string, string[]>();

  for (const file of adrFiles) {
    const number = file.slice(0, 4);
    byNumber.set(number, [...(byNumber.get(number) ?? []), file]);
  }

  for (const [number, files] of byNumber) {
    if (files.length > 1) {
      violations.push({
        file: `docs/adr/${files[0]}`,
        line: 1,
        message: `ADR number ${number} is used by ${files.length} files: ${files.join(', ')}`,
      });
    }
  }
};

for (const file of markdownFiles) {
  const lines = readFileSync(join(repoRoot, file), 'utf8').split('\n');

  checkLinks(file, lines);

  if (file.startsWith('.rulesync/') || file.startsWith('docs/standards/skills/')) {
    checkBacktickPaths(file, lines);
    checkPnpmScripts(file, lines);
  }

  if (file.startsWith('docs/guides/') || file.startsWith('docs/platform/')) {
    checkBacktickPaths(file, lines);
  }

  if (file.startsWith('.rulesync/skills/')) {
    checkFrontmatter(file, lines);
  }

  if (file === '.rulesync/rules/overview.md') {
    checkRosterMentions(file, lines);
  }
}

checkAdrNumbering();

if (violations.length > 0) {
  for (const { file, line, message } of violations) {
    console.error(`${file}:${line}: ${message}`);
  }

  console.error(`\n${violations.length} reference violation(s). Fix the pointer or the target.`);
  process.exit(1);
}

console.log(`references in sync (${markdownFiles.length} markdown files checked).`);
