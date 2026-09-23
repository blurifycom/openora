// The consumer review precheck hands reviewer agents facts instead of files. Build a throwaway
// consumer repo with a base branch and a feature branch, run the template script against it,
// and assert on the lines the review skill parses.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(
  new URL('../templates/consumer/tools/review-precheck.mjs', import.meta.url),
);
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'review-precheck-')));
after(() => rmSync(repo, { recursive: true, force: true }));

const git = (...args) =>
  execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
const write = (files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
};
const commit = (message, files) => {
  write(files);
  git('add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
};
const precheck = (...args) =>
  execFileSync('node', [script, ...args], { cwd: repo, encoding: 'utf8' }).split('\n');

git('init', '-q', '-b', 'dev');
commit('base', {
  '.rulesync/sync.json': JSON.stringify({
    reviewPrecheck: {
      bannedClasses: [{ paths: ['apps/web'], tokens: ['btn', 'alert', 'tabs'] }],
      reactCompilerPaths: ['apps/web'],
    },
  }),
  'apps/web/src/mod/locales/en.json': JSON.stringify({ title: 'Title' }),
  'apps/web/src/mod/locales/de.json': JSON.stringify({ title: 'Titel' }),
  'apps/web/src/other/locales/en.json': JSON.stringify({ title: 'Title', greeting: 'Hi' }),
  'apps/web/src/other/locales/fr.json': JSON.stringify({ title: 'Titre', greeting: 'Salut' }),
  'apps/web/src/mod/tone.ts': 'export const TONE: Record<Kind, Tone> = {};\n',
  'apps/web/src/other.ts': 'export const other = 1;\n',
});
git('checkout', '-q', '-b', 'feature');
const firstFeature = commit('feature', {
  'apps/web/src/mod/locales/en.json': JSON.stringify({ title: 'Title', added: 'Added' }),
  'apps/web/src/other/locales/fr.json': JSON.stringify({ title: 'Titre' }),
  'apps/web/src/mod/tone.ts': 'export const TONE: Partial<Record<Kind, Tone>> = {};\n',
  'apps/web/src/mod/page.tsx': [
    "import { a as b } from './x';",
    'const PROVIDERS_LIMIT = 100;',
    'const status = key as Status;',
    'const tabs = useMemo(() => [], []);',
    "const styles = { banner: 'alert alert-error p-4' } as const;",
    "<span className={styles.banner} role=\"alert\" aria-label={t('tabs.left', 'Scroll tabs left')} />",
    "const label = t('added');",
    "const missing = t('nope.key');",
    'const balance = wallet.balance;',
  ].join('\n'),
  'apps/web/src/mod/__tests__/page.test.tsx': 'const x = y as Z;\n',
  'pnpm-lock.yaml': 'lock\n',
});

test('scopes reviewable files and names every skipped one with its reason', () => {
  const out = precheck('--base', 'dev', '--head', 'feature');
  assert.match(out[0], /^SCOPE: files 6 .* reviewable 2 .* skipped 4 mode full$/);
  assert.ok(out.includes('REVIEWABLE: apps/web/src/mod/page.tsx +9/-0'));
  assert.ok(out.includes('SKIPPED: pnpm-lock.yaml - lockfile'));
  assert.ok(out.includes('SKIPPED: apps/web/src/mod/__tests__/page.test.tsx - test'));
  assert.ok(
    out.includes('SKIPPED: apps/web/src/mod/locales/en.json - locale data (see i18n checks)'),
  );
});

test('reports mechanical checks on added lines only, never on tests or aliases', () => {
  const out = precheck('--base', 'dev', '--head', 'feature').join('\n');
  assert.match(out, /page\.tsx:3 - type-cast - `as Status`/);
  assert.doesNotMatch(out, /page\.tsx:1 - type-cast/);
  assert.doesNotMatch(out, /PRECHECK: .*page\.test\.tsx/);
  assert.doesNotMatch(out, /as const`/);
  assert.match(out, /tone\.ts:1 - type-cast - `Record` widened to `Partial<Record>`/);
  assert.match(out, /page\.tsx:2 - hardcoded-limit - `PROVIDERS_LIMIT = 100`/);
  assert.match(out, /page\.tsx:4 - hand-memo/);
  assert.match(out, /page\.tsx:5 - banned-class - `alert alert-error`/);
  assert.doesNotMatch(out, /page\.tsx:6 - banned-class/);
});

test('flags locale keys a sibling added and t() keys no locale file has', () => {
  const out = precheck('--base', 'dev', '--head', 'feature').join('\n');
  assert.match(out, /de\.json:1 - i18n-parity - missing 1 key\(s\) a sibling locale added: added/);
  assert.doesNotMatch(out, /en\.json:1 - i18n-parity/);
  assert.match(out, /page\.tsx:8 - i18n-missing-key - `nope\.key`/);
  assert.doesNotMatch(out, /`added` not in/);
});

test('flags a key dropped from one locale while a sibling still has it', () => {
  const out = precheck('--base', 'dev', '--head', 'feature').join('\n');
  assert.match(
    out,
    /fr\.json:1 - i18n-parity - dropped 1 key\(s\) a sibling locale still has: greeting/,
  );
});

test('counts domain hits so a reviewer can short-circuit on zero', () => {
  const out = precheck('--base', 'dev', '--head', 'feature');
  assert.ok(out.includes('DOMAIN: compliance hits 1'));
  assert.ok(
    out.some((row) => row.startsWith('DOMAIN-HIT: compliance apps/web/src/mod/page.tsx:9')),
  );
  assert.ok(out.includes('DOMAIN: security hits 0'));
});

test('--since narrows to files changed after the last review and ignores merged base work', () => {
  git('checkout', '-q', 'dev');
  commit('base moves', { 'apps/web/src/other.ts': 'export const other = 2;\n' });
  git('checkout', '-q', 'feature');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'merge', '-q', '--no-edit', 'dev');
  commit('fix', {
    'apps/web/src/mod/tone.ts': 'export const TONE: Record<Kind, Tone | null> = {};\n',
  });
  const out = precheck('--base', 'dev', '--head', 'feature', '--since', firstFeature);
  assert.match(out[0], /reviewable 1 .* skipped 0 mode incremental$/);
  assert.ok(out.includes('REVIEWABLE: apps/web/src/mod/tone.ts +1/-1'));
  assert.ok(!out.some((row) => row.includes('other.ts')));
});

test('a --since that is not an ancestor falls back to a full review and says so', () => {
  git('checkout', '-q', '-b', 'stray', 'dev');
  const stray = commit('stray', { 'stray.ts': 'export {};\n' });
  git('checkout', '-q', 'feature');
  const out = precheck('--base', 'dev', '--head', 'feature', '--since', stray);
  assert.match(out[0], /mode full$/);
  assert.ok(out.some((row) => row.startsWith('NOTE: --since')));
});

test('a PR cannot widen its own skip policy: extraSkipGlobs is read from the base revision', () => {
  git('checkout', '-q', '-b', 'spoof-base', 'dev');
  git('checkout', '-q', '-b', 'spoof-head');
  commit('widen own skip policy and touch code', {
    '.rulesync/sync.json': JSON.stringify({ reviewPrecheck: { extraSkipGlobs: ['apps/**'] } }),
    'apps/web/src/mod/tone.ts': 'export const TONE: Record<Kind, Tone> = { x: 1 };\n',
  });
  const out = precheck('--base', 'spoof-base', '--head', 'spoof-head');
  assert.ok(out.some((row) => row.startsWith('REVIEWABLE: apps/web/src/mod/tone.ts')));
  assert.ok(!out.some((row) => row.startsWith('SKIPPED: apps/web/src/mod/tone.ts')));
});

test('a removed line can lose a domain hit as easily as an added line can gain one', () => {
  git('checkout', '-q', '-b', 'guard-base', 'dev');
  commit('add a guard', {
    'apps/web/src/mod/route.ts': 'export function h() {\n  adminGuard.assert();\n}\n',
  });
  git('checkout', '-q', '-b', 'guard-removed');
  commit('remove the guard', { 'apps/web/src/mod/route.ts': 'export function h() {}\n' });
  const out = precheck('--base', 'guard-base', '--head', 'guard-removed').join('\n');
  assert.match(
    out,
    /DOMAIN-HIT: security apps\/web\/src\/mod\/route\.ts - \/.*guard.*\/ \(removed\)/,
  );
});

test('--since reports only hunks added after the last review, not the whole file again', () => {
  git('checkout', '-q', 'feature');
  const reviewed = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'follow-up');
  const page = 'apps/web/src/mod/page.tsx';
  commit('follow-up', {
    [page]: `const late = value as Late;\n${readFileSync(join(repo, page), 'utf8')}`,
  });
  const out = precheck('--base', 'dev', '--head', 'follow-up', '--since', reviewed);
  const text = out.join('\n');
  assert.ok(out.includes(`REVIEWABLE: ${page} +1/-0`));
  assert.match(text, /page\.tsx:1 - type-cast - `as Late`/);
  assert.doesNotMatch(text, /`as Status`/);
  assert.ok(out.includes('DOMAIN: compliance hits 0'));
});
