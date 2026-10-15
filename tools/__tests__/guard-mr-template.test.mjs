// The consumer guard-mr hook keeps an agent from opening a merge/pull request on a commit
// `pnpm verify` never passed. Drive it in a throwaway git repo: no stamp is denied, a stamp of
// the clean HEAD is allowed, and a new commit or an uncommitted edit invalidates it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(
  new URL('../templates/consumer/__dot__rulesync/hooks/', import.meta.url),
);
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guard-mr-')));
const guard = join(repo, '.rulesync', 'hooks', 'guard-mr.mjs');

mkdirSync(join(repo, '.rulesync', 'hooks'), { recursive: true });
copyFileSync(join(hooks, '_shared.mjs'), join(repo, '.rulesync', 'hooks', '_shared.mjs'));
copyFileSync(join(hooks, 'guard-mr.mjs'), guard);
writeFileSync(join(repo, '.gitignore'), 'node_modules\n');
const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
git('init', '-q');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'hooks');
after(() => rmSync(repo, { recursive: true, force: true }));

const exitCode = (command) =>
  spawnSync('node', [guard], {
    cwd: repo,
    input: JSON.stringify({ tool_input: { command }, cwd: repo }),
  }).status;
const stamp = () => spawnSync('node', [guard, '--stamp'], { cwd: repo }).status;
const DENIED = 2;
const ALLOWED = 0;

test('commands that do not open a review are allowed', () => {
  assert.equal(exitCode('glab mr list'), ALLOWED);
  assert.equal(exitCode('git push'), ALLOWED);
});

test('opening an MR or PR without a verify stamp is denied', () => {
  assert.equal(exitCode('glab mr create --fill'), DENIED);
  assert.equal(exitCode('gh pr create --base dev'), DENIED);
  assert.equal(exitCode('git push -o merge_request.create'), DENIED);
});

test('a stamp of the clean HEAD allows it', () => {
  assert.equal(stamp(), 0);
  assert.equal(exitCode('glab mr create --fill'), ALLOWED);
});

test('an uncommitted edit or a new commit invalidates the stamp', () => {
  writeFileSync(join(repo, 'a.txt'), 'a');
  assert.equal(exitCode('gh pr create'), DENIED);
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
  assert.equal(exitCode('gh pr create'), DENIED);
});

test('a stamp taken on a dirty tree is not recorded', () => {
  writeFileSync(join(repo, 'b.txt'), 'b');
  stamp();
  rmSync(join(repo, 'b.txt'));
  assert.equal(exitCode('gh pr create'), DENIED);
});
