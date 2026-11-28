import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type SourceFile = { path: string; text: string };
export type Usage = { path: string; line: number; text: string };
export type SymbolHit = { path: string; line: number; body: string[] };

export const LINE_WIDTH = 160;
const isTest = (path: string) => /__tests__\/|\.(test|spec)\.tsx?$/.test(path);
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function findCoreSourceRoot(catalogPath: string): string | null {
  let dir = dirname(realpathSync(catalogPath));
  for (let hop = 0; hop < 4; hop++) {
    const candidate = join(dir, 'packages', 'core', 'src');
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  return null;
}

export function readSourceTree(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
        walk(path);
      } else if (entry.isFile() && /\.tsx?$/.test(path) && !path.endsWith('.d.ts')) {
        files.push({ path, text: readFileSync(join(root, path), 'utf8') });
      }
    }
  };
  walk('');
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

const inModule = (path: string, module: string) =>
  path.startsWith(`${module}/`) || path.includes(`/${module}/`);

export function findUsages(
  files: SourceFile[],
  name: string,
  opts: { module?: string | undefined; includeTests?: boolean | undefined } = {},
): Usage[] {
  const word = new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`);
  const usages: Usage[] = [];
  for (const file of files) {
    if (
      !file.text.includes(name) ||
      (!opts.includeTests && isTest(file.path)) ||
      (opts.module && !inModule(file.path, opts.module))
    ) {
      continue;
    }
    file.text.split('\n').forEach((text, i) => {
      if (word.test(text) && !COMMENT_LINE.test(text)) {
        usages.push({ path: file.path, line: i + 1, text: text.trim().slice(0, LINE_WIDTH) });
      }
    });
  }
  return usages;
}

export function findSymbol(
  files: SourceFile[],
  name: string,
  opts: { file?: string | undefined } = {},
): SymbolHit[] {
  const dot = name.lastIndexOf('.');
  const owner = dot > 0 ? name.slice(0, dot) : null;
  const member = name.slice(dot + 1);
  if (!member) {
    return [];
  }
  const m = escapeRegExp(member);
  const declaration = new RegExp(
    [
      `^(?:export\\s+)?(?:default\\s+)?(?:declare\\s+)?(?:abstract\\s+)?(?:async\\s+)?(?:function\\*?|const|let|type|interface|class|enum)\\s+${m}\\b`,
      `^\\s+(?:(?:public|private|protected|static|readonly|override|async|get)\\s+)*${m}\\??\\s*(?:<[^>]*>)?\\s*\\(`,
      `^\\s+(?:readonly\\s+)?${m}\\??\\s*[:=]\\s*(?:async\\s*)?(?:<[^>]*>)?\\(`,
    ].join('|'),
  );
  const ownerDeclaration = owner
    ? new RegExp(
        `^(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|interface|type|const)\\s+${escapeRegExp(owner)}\\b`,
      )
    : null;
  const hits: SymbolHit[] = [];
  for (const file of files) {
    if (
      !file.text.includes(member) ||
      isTest(file.path) ||
      (opts.file && !file.path.includes(opts.file))
    ) {
      continue;
    }
    const lines = file.text.split('\n');
    const start = ownerDeclaration ? lines.findIndex((l) => ownerDeclaration.test(l)) : 0;
    if (start < 0) {
      continue;
    }
    const end = ownerDeclaration ? start + blockFrom(lines, start).length : lines.length;
    for (let i = start; i < end; i++) {
      if (declaration.test(lines[i] ?? '')) {
        const body = blockFrom(lines, i);
        hits.push({ path: file.path, line: i + 1, body });
        i += body.length - 1;
      }
    }
  }
  return hits;
}

const CLOSER_ONLY = /^\s*[})\]]+[;,)]*\s*$/;
const indentOf = (line: string) => line.length - line.trimStart().length;

export function outline(hit: SymbolHit): string[] {
  const [first = ''] = hit.body;
  const depth = /\b(?:class|interface|enum)\s/.test(first) ? 2 : 4;
  const limit = indentOf(first) + depth;
  return hit.body.flatMap((line, i) =>
    line.trim() && !CLOSER_ONLY.test(line) && !COMMENT_LINE.test(line) && indentOf(line) <= limit
      ? [`${hit.line + i}: ${line}`]
      : [],
  );
}

const STRING_OR_COMMENT = /(['"`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\/.*$/g;

function blockFrom(lines: string[], start: number): string[] {
  let depth = 0;
  let opened = false;
  const body: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? '';
    body.push(line);
    const code = COMMENT_LINE.test(line) ? '' : line.replace(STRING_OR_COMMENT, '');
    for (const ch of code) {
      if ('{(['.includes(ch)) {
        depth++;
        opened = true;
      } else if ('})]'.includes(ch)) {
        depth--;
      }
    }
    if (opened ? depth <= 0 && !/=>?\s*$/.test(code) : /;\s*$/.test(line)) {
      break;
    }
  }
  return body;
}
