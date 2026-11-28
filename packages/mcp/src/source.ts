import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Lookups over the platform's TypeScript source for the two steps agents otherwise run by hand
// on almost every task: grep an identifier, then print the lines around its definition.

export type SourceFile = { path: string; text: string };
export type Usage = { path: string; line: number; text: string };
export type SymbolHit = { path: string; line: number; body: string[] };

export const LINE_WIDTH = 160;
const isTest = (path: string) => /__tests__\/|\.(test|spec)\.tsx?$/.test(path);
const COMMENT_LINE = /^\s*(?:\/\/|\/?\*)/;
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The catalog sits at the root of a platform checkout (`docs/catalog.json`), or in the MCP
// package's `docs/` inside one when a consumer links the checkout. A consumer on the npm
// package has no source to read.
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

// `wallet` matches `wallet/...`; `bonus` and `promo/bonus` match `promo/bonus/...`.
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

// `withdraw`, `WalletService.withdraw`, `WithdrawInputSchema`, `WalletCommands`: each matching
// declaration with its body, up to the closing bracket (or the `;` of a one-liner).
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
      // Top-level forms start at column 0, so a `type X,` line in an import list is not one.
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

// A body too long to print whole, cut to its shape: a class or interface keeps its member lines,
// anything else its statements and one nesting level (the `if`, `throw`, `await` lines).
// Each line keeps its number so the caller can read the part it needs.
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

// Disjoint branches (escape vs non-backslash) keep this linear on a run of backslashes.
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
    // `=> ` or `=` at the end of a line means the body starts on the next one.
    if (opened ? depth <= 0 && !/=>?\s*$/.test(code) : /;\s*$/.test(line)) {
      break;
    }
  }
  return body;
}
