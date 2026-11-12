// The consumer guard-review hook keeps an agent from pushing or opening a PR/MR on a commit the
// `review` skill never approved. Drive it in a throwaway git repo: no review state is denied, an
// APPROVED or GO state for HEAD is allowed, a stale or rejected one is denied, deletes pass.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const hooks = fileURLToPath(
  new URL('../templates/consumer/__dot__rulesync/hooks/', import.meta.url),
);
const repo = realpathSync(mkdtempSync(join(tmpdir(), 'guard-review-')));
const guard = join(repo, '.rulesync', 'hooks', 'guard-review.mjs');
const reviews = join(repo, '.claude', 'reviews');

mkdirSync(join(repo, '.rulesync', 'hooks'), { recursive: true });
copyFileSync(join(hooks, '_shared.mjs'), join(repo, '.rulesync', 'hooks', '_shared.mjs'));
copyFileSync(join(hooks, 'guard-review.mjs'), guard);
writeFileSync(join(repo, '.gitignore'), '.claude/\n');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
git('init', '-q', '-b', 'feat/x');
git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
const head = git('rev-parse', 'HEAD');
after(() => rmSync(repo, { recursive: true, force: true }));
beforeEach(() => rmSync(reviews, { recursive: true, force: true }));

const saveReview = (sha, verdict) => {
  mkdirSync(reviews, { recursive: true });
  writeFileSync(join(reviews, 'feat-x.json'), JSON.stringify({ sha, verdict }));
};
const exitCode = (command) =>
  spawnSync('node', [guard], {
    cwd: repo,
    input: JSON.stringify({ tool_input: { command }, cwd: repo }),
  }).status;
const DENIED = 2;
const ALLOWED = 0;

test('commands that send nothing for review are allowed', () => {
  assert.equal(exitCode('git status'), ALLOWED);
  assert.equal(exitCode('git commit -m "wip; git push next"'), ALLOWED);
  assert.equal(exitCode('git push origin --delete feat/x'), ALLOWED);
  assert.equal(exitCode('git push origin :feat/x'), ALLOWED);
  assert.equal(exitCode('git push --tags'), ALLOWED);
  assert.equal(exitCode('glab mr create --source-branch dev --target-branch stage'), ALLOWED);
});

test('a push or a new PR without an approved review is denied', () => {
  assert.equal(exitCode('git push -u origin feat/x'), DENIED);
  assert.equal(exitCode(`cd ${repo} && git push`), DENIED);
  assert.equal(exitCode(`git -C ${repo} push`), DENIED);
  assert.equal(exitCode('git -c core.x=y push'), DENIED);
  assert.equal(exitCode('GIT_TRACE=1 git push'), DENIED);
  assert.equal(exitCode('gh -R o/r pr create --fill'), DENIED);
  assert.equal(exitCode('gh pr create --fill'), DENIED);
  assert.equal(exitCode('gh stack submit'), DENIED);
  assert.equal(exitCode('glab mr create --fill'), DENIED);
});

test('a delete or tag flag elsewhere in a chain does not excuse a push', () => {
  assert.equal(exitCode('git push -u origin feat && gh pr create -d --fill'), DENIED);
  assert.equal(exitCode('git push -u origin HEAD && glab mr create -d desc'), DENIED);
  assert.equal(exitCode('git push origin feat --tags'), DENIED);
  assert.equal(exitCode('git push && gh pr create --body "drop the -d flag"'), DENIED);
  assert.equal(exitCode('git push origin feat && git push origin --delete old'), DENIED);
});

test('an APPROVED or GO review of HEAD lets the push through', () => {
  saveReview(head, 'APPROVED');
  assert.equal(exitCode('git push'), ALLOWED);
  saveReview(head, 'GO - 0 BLOCK');
  assert.equal(exitCode('gh pr create --fill'), ALLOWED);
  saveReview(head.toUpperCase(), 'APPROVED');
  assert.equal(exitCode('git push'), ALLOWED);
});

test('an abbreviated SHA is not an approval', () => {
  saveReview(head.slice(0, 12), 'APPROVED');
  assert.equal(exitCode('git push'), DENIED);
});

test('a push chained after a command that moves HEAD is denied', () => {
  saveReview(head, 'APPROVED');
  assert.equal(exitCode('git commit -am "x" && git push'), DENIED);
  assert.equal(exitCode('git -c a=b rebase origin/dev; gh pr create --fill'), DENIED);
  assert.equal(exitCode('git status && git push'), ALLOWED);
  assert.equal(exitCode('git commit -am "x" && git push origin --delete old'), ALLOWED);
});

test('a PR/MR naming its source branch is judged by that branch', () => {
  git('branch', 'feat/unreviewed', 'HEAD');
  git('checkout', '-q', '-b', 'main');
  saveReview(head, 'APPROVED');
  assert.equal(exitCode('gh pr create --head feat/x --base dev'), ALLOWED);
  assert.equal(exitCode('glab mr create --source-branch feat/missing'), DENIED);
  assert.equal(exitCode('glab mr create --fill'), ALLOWED);
  git('checkout', '-q', 'feat/unreviewed');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'u');
  git('checkout', '-q', 'main');
  assert.equal(exitCode('gh pr create --head me:feat/unreviewed'), DENIED);
  git('checkout', '-q', 'feat/x');
});

test('a hand merge is denied, quoted prose about one is not', () => {
  for (const command of [
    'gh pr merge 12 --squash',
    'gh stack merge',
    'gh -R o/r pr merge 1',
    'GH_REPO=o/r gh pr merge 1',
    'glab mr merge 5',
    'git status && glab mr merge 5',
    'gh pr -R o/r merge 1',
    'command gh pr merge 1',
    '/opt/homebrew/bin/gh pr merge 1',
    'gh api -X PUT repos/o/r/pulls/1/merge',
    "gh api graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'",
  ]) {
    assert.equal(exitCode(command), DENIED, command);
  }
  assert.equal(exitCode('git commit -m "run gh pr merge later"'), ALLOWED);
  assert.equal(exitCode('gh api repos/o/r/pulls/1/merge'), ALLOWED);
  assert.equal(exitCode('gh pr list --search merge'), ALLOWED);
  assert.equal(
    exitCode("gh api graphql -f query='{ repository { mergeQueue { url } } }'"),
    ALLOWED,
  );
});

test('a push to a shared branch is denied even on an approved HEAD', () => {
  saveReview(head, 'APPROVED');
  for (const command of [
    'git push origin dev',
    'git push -u origin HEAD:dev',
    'git push origin +feat/x:refs/heads/main',
    'git push --all origin',
    'git push origin --delete dev',
    'git push origin :dev',
    'git push origin "HEAD:dev"',
    "git push origin 'refs/heads/*:refs/heads/*'",
    'git push origin HEAD:"dev"',
    'git push origin HEAD:d\\ev',
    "git push origin HEAD:de''v",
    'git push origin HEAD:heads/dev',
    'git push -o ci.skip origin dev',
    'git push --repo origin HEAD:dev',
  ]) {
    assert.equal(exitCode(command), DENIED, command);
  }
  assert.equal(exitCode('git push -u origin HEAD'), ALLOWED);
  assert.equal(exitCode('git push origin feat/x:feat/x dev-notes'), ALLOWED);
  assert.equal(exitCode('git push origin @'), ALLOWED);
});

test('a bare push is judged by where git sends it, not by the branch name', () => {
  saveReview(head, 'APPROVED');
  git('update-ref', 'refs/remotes/origin/dev', head);
  git('config', 'remote.origin.url', repo);
  git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  git('config', 'branch.feat/x.remote', 'origin');
  git('config', 'branch.feat/x.merge', 'refs/heads/dev');
  git('config', 'push.default', 'upstream');
  try {
    assert.equal(exitCode('git push'), DENIED);
    assert.equal(exitCode('git push --tags'), ALLOWED);
  } finally {
    git('config', '--unset', 'push.default');
    git('config', '--remove-section', 'branch.feat/x');
    git('config', '--remove-section', 'remote.origin');
    git('update-ref', '-d', 'refs/remotes/origin/dev');
  }
});

test('a promotion sent from a shared branch needs no branch review', () => {
  const trunk = `${repo}-dev`;
  git('worktree', 'add', '-q', '-b', 'dev', trunk);
  after(() => rmSync(trunk, { recursive: true, force: true }));
  assert.equal(exitCode(`cd ${trunk} && gh pr create --base stage --fill`), ALLOWED);
  assert.equal(exitCode(`cd ${trunk} && git push`), DENIED);
});

test('a review saved in the main checkout covers a linked worktree', () => {
  const worktree = `${repo}-wt`;
  git('worktree', 'add', '-q', '-b', 'feat/wt', worktree);
  after(() => rmSync(worktree, { recursive: true, force: true }));
  saveReview(head, 'APPROVED');
  assert.equal(exitCode(`cd ${worktree} && git push`), ALLOWED);
});

test('a rejected or stale review is denied', () => {
  saveReview(head, 'NO-GO - 1 BLOCK');
  assert.equal(exitCode('git push'), DENIED);
  saveReview(head, 'CHANGES_REQUESTED');
  assert.equal(exitCode('git push'), DENIED);
  saveReview('0'.repeat(40), 'APPROVED');
  assert.equal(exitCode('git push'), DENIED);
});
