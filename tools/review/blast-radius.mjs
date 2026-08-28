#!/usr/bin/env node
/**
 * Prints the blast radius of the current change set for a code review:
 * for every changed source file, each exported symbol and the files that use it;
 * for every changed Drizzle table, the files that use the table and the SQL name;
 * for every changed migration, the statements that need a compatibility check.
 *
 * Usage: node tools/review/blast-radius.mjs [--base <ref>] [--json]
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);
const baseIndex = args.indexOf('--base');
const base = baseIndex >= 0 ? args[baseIndex + 1] : 'dev';
const asJson = args.includes('--json');

const git = (...cmd) => {
  try {
    return execFileSync('git', cmd, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
};
const lines = (s) => (s ? s.split('\n') : []);

const branchDiff = lines(git('diff', `${base}...HEAD`, '--name-only'));
const workingTree = () => [
  ...lines(git('diff', '--name-only', 'HEAD')),
  ...lines(git('ls-files', '--others', '--exclude-standard')),
];
const changed = branchDiff.length > 0 ? branchDiff : workingTree();

const isSource = (f) =>
  /\.(ts|tsx|mjs)$/.test(f) && !/(__tests__|\.test\.|\.spec\.|\.d\.ts$)/.test(f);
const isMigration = (f) => f.endsWith('.sql');
const read = (f) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};

const EXPORT_RE = /export\s+(?:async\s+)?(?:const|function|class|type|enum|let)\s+(\w+)/g;
const EXPORT_LIST_RE = /export\s*\{([^}]+)\}/g;
const TABLE_RE = /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*['"](\w+)['"]/g;

const matchAll = (re, text, pick) => [...text.matchAll(re)].map(pick);
const exportsOf = (text) => [
  ...matchAll(EXPORT_RE, text, (m) => m[1]),
  ...matchAll(EXPORT_LIST_RE, text, (m) => m[1]).flatMap((list) =>
    list
      .split(',')
      .map((s) =>
        s
          .trim()
          .split(/\s+as\s+/)
          .pop(),
      )
      .filter(Boolean),
  ),
];
const tablesOf = (text) => matchAll(TABLE_RE, text, (m) => ({ symbol: m[1], sql: m[2] }));

const CODE_PATHSPEC = ['*.ts', '*.tsx', '*.mjs', '*.sql', ':!**/node_modules/**', ':!*.d.ts'];
const usersOf = (word, self) =>
  lines(git('grep', '-l', '-w', '-e', word, '--', ...CODE_PATHSPEC)).filter((f) => f !== self);

const RISKY_SQL =
  /\b(DROP|RENAME|SET NOT NULL|ALTER COLUMN .* TYPE|ADD COLUMN(?!.*DEFAULT).*NOT NULL)\b/i;
const riskyStatements = (text) =>
  text
    .split(';')
    .map((s) => s.trim())
    .filter((s) => RISKY_SQL.test(s));

const report = changed.filter(isSource).map((file) => {
  const text = read(file);
  return {
    file,
    exports: [...new Set(exportsOf(text))].map((symbol) => ({
      symbol,
      users: usersOf(symbol, file),
    })),
    tables: tablesOf(text).map((t) => ({
      ...t,
      users: usersOf(t.symbol, file),
      migrations: usersOf(t.sql, file).filter(isMigration),
    })),
  };
});
const migrations = changed
  .filter(isMigration)
  .map((file) => ({ file, risky: riskyStatements(read(file)) }));

const list = (xs) => (xs.length ? xs.join(', ') : '(none outside diff)');
const fileSection = ({ file, exports, tables }) => [
  `## ${file}`,
  ...exports.map(({ symbol, users }) => `- export ${symbol} -> ${list(users)}`),
  ...tables.flatMap(({ symbol, sql, users, migrations }) => [
    `- table ${symbol} (${sql}) -> ${list(users)}`,
    `  migrations: ${list(migrations)}`,
  ]),
  '',
];
const migrationSection = ({ file, risky }) => [
  `## migration ${file}`,
  ...(risky.length
    ? risky.map((s) => `- CHECK COMPAT: ${s.replace(/\s+/g, ' ')}`)
    : ['- no destructive or narrowing statement found']),
  '',
];
const sections = [
  ...report.filter((r) => r.exports.length > 0 || r.tables.length > 0).map(fileSection),
  ...migrations.map(migrationSection),
];
const text = asJson
  ? JSON.stringify({ base, changed, files: report, migrations }, null, 2)
  : [`# Blast radius vs ${base} (${changed.length} changed files)`, '', ...sections.flat()].join(
      '\n',
    );
process.stdout.on('error', () => {});
process.stdout.write(`${text}\n`);
