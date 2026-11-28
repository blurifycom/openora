// The consumer guard-mr hook keeps an agent from opening a merge/pull request on a commit
// `pnpm verify` never passed. Drive it in a throwaway git repo: no stamp is denied, a stamp of
// the clean HEAD is allowed, and a new commit or an uncommitted edit invalidates it.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
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
git('remote', 'add', 'origin', 'git@github.com:o/r.git');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
git('add', '-A');
git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'hooks');
after(() => rmSync(repo, { recursive: true, force: true }));

const exitCode = (command) =>
  spawnSync('node', [guard], {
    cwd: repo,
    input: JSON.stringify({ tool_input: { command }, cwd: repo }),
  }).status;
const stamp = (lifecycleEvent = 'verify') =>
  spawnSync('node', [guard, '--stamp'], {
    cwd: repo,
    env: { ...process.env, npm_lifecycle_event: lifecycleEvent },
  }).status;
const DENIED = 2;
const ALLOWED = 0;

test('commands that do not open a review are allowed', () => {
  assert.equal(exitCode('glab mr list'), ALLOWED);
  assert.equal(exitCode('git push'), ALLOWED);
  assert.equal(exitCode('gh api repos/o/r/pulls'), ALLOWED);
  assert.equal(exitCode('gh api repos/o/r/pulls -f state=open --method GET'), ALLOWED);
  assert.equal(exitCode('gh api repos/o/r/pulls/1/comments -f body=ok'), ALLOWED);
  assert.equal(exitCode('rg "glab mr create" docs'), ALLOWED);
  assert.equal(exitCode('git commit -m "docs: say gh pr create opens a draft"'), ALLOWED);
  assert.equal(exitCode('rg createPullRequest src'), ALLOWED);
});

test('a promotion from a shared branch needs no stamp', () => {
  assert.equal(exitCode('glab mr create --source-branch dev --target-branch stage'), ALLOWED);
  assert.equal(exitCode('gh pr create --head stage --base prod'), ALLOWED);
});

test('opening an MR or PR without a verify stamp is denied', () => {
  assert.equal(exitCode('glab mr create --fill'), DENIED);
  assert.equal(exitCode('gh pr create --base dev'), DENIED);
  assert.equal(exitCode('git push -o merge_request.create'), DENIED);
  assert.equal(exitCode('gh api --method POST repos/o/r/pulls -f head=a -f base=dev'), DENIED);
  assert.equal(exitCode('gh api repos/o/r/pulls -f head=a -f base=dev'), DENIED);
  assert.equal(exitCode('glab api -X POST projects/1/merge_requests -f source_branch=a'), DENIED);
  assert.equal(
    exitCode(
      "gh api graphql -f query='mutation { createPullRequest(input: {}) { clientMutationId } }'",
    ),
    DENIED,
  );
});

test('a stamp outside `pnpm verify` is refused', () => {
  assert.equal(stamp('test:tools'), 1);
  assert.equal(exitCode('gh pr create'), DENIED);
});

test('a stamp of the clean HEAD allows it', () => {
  assert.equal(stamp(), 0);
  assert.equal(exitCode('glab mr create --fill'), ALLOWED);
  git('branch', 'verified');
});

test('an uncommitted edit or a new commit invalidates the stamp', () => {
  writeFileSync(join(repo, 'a.txt'), 'a');
  assert.equal(exitCode('gh pr create'), DENIED);
  git('add', 'a.txt');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'a');
  assert.equal(exitCode('gh pr create'), DENIED);
});

test('a named source branch is judged by its own commit', () => {
  git('branch', 'unverified');
  assert.equal(exitCode('glab mr create --source-branch verified --target-branch dev'), ALLOWED);
  assert.equal(exitCode('gh pr create --head me:verified'), ALLOWED);
  assert.equal(exitCode('glab mr create --source-branch unverified'), DENIED);
  assert.equal(exitCode('gh pr create --head missing'), DENIED);
});

test('a stamp taken on a dirty tree is not recorded', () => {
  writeFileSync(join(repo, 'b.txt'), 'b');
  stamp();
  rmSync(join(repo, 'b.txt'));
  assert.equal(exitCode('gh pr create'), DENIED);
});

test('only the create command names the source branch, glued or repeated', () => {
  assert.equal(exitCode('glab mr create -sverified'), ALLOWED);
  assert.equal(exitCode('gh pr create -Hverified'), ALLOWED);
  assert.equal(exitCode('gh pr create -Hunverified'), DENIED);
  assert.equal(exitCode('glab mr create -sunverified'), DENIED);
  assert.equal(exitCode('ls -s dev && gh pr create'), DENIED);
  assert.equal(exitCode('gh pr create && echo --head dev'), DENIED);
  assert.equal(exitCode('gh pr create -H dev -H unverified'), DENIED);
  assert.equal(exitCode('glab mr create -H o/r --source-branch unverified'), DENIED);
  assert.equal(exitCode('git status -s && glab mr create --source-branch verified'), ALLOWED);
  assert.equal(exitCode('gh stack submit --auto'), DENIED);
  assert.equal(exitCode('gh pr create -H verified && gh pr create -H unverified'), DENIED);
  assert.equal(exitCode('gh pr create -H dev && gh pr create -H unverified'), DENIED);
  assert.equal(exitCode('gh pr create -H verified && glab mr create -s verified'), ALLOWED);
});

test('aliases, combined short flags and quoted separators are read', () => {
  assert.equal(exitCode('gh pr new -H unverified'), DENIED);
  assert.equal(exitCode('glab mr new -s unverified'), DENIED);
  assert.equal(exitCode('gh pr -R o/r create -H unverified'), DENIED);
  assert.equal(exitCode('gh pr create -dH unverified'), DENIED);
  assert.equal(exitCode('glab mr create -ys unverified'), DENIED);
  assert.equal(exitCode('gh pr create -dH verified'), ALLOWED);
  assert.equal(exitCode('gh pr create -H=dev'), ALLOWED);
  assert.equal(exitCode("gh pr create -t 'x;y' -H unverified"), DENIED);
  assert.equal(exitCode("gh pr create -t 'x;y' -H verified"), ALLOWED);
});

test('a guarded checkout is held to its stamp whatever repository a create names', () => {
  assert.equal(exitCode('gh pr create -R other/repo -H unverified'), DENIED);
  assert.equal(exitCode('gh pr create -R other/x -H verified; gh pr create -H unverified'), DENIED);
  assert.equal(exitCode(`cd "${repo}" && gh pr create -H unverified`), DENIED);
  assert.equal(exitCode("sh -c 'gh pr create -H unverified'"), DENIED);
  assert.equal(exitCode('eval "glab mr create -s unverified"'), DENIED);
});

test("a checkout of another repository is left to that repository's rules", () => {
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'guard-mr-other-')));
  execFileSync('git', ['init', '-q'], { cwd: other });
  execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/other/repo.git'], {
    cwd: other,
  });
  execFileSync(
    'git',
    ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init'],
    { cwd: other },
  );
  const from = (command) =>
    spawnSync('node', [guard], {
      cwd: other,
      input: JSON.stringify({ tool_input: { command }, cwd: other }),
    }).status;
  try {
    assert.equal(from('gh pr create --draft --base dev --head feat'), ALLOWED);
    assert.equal(
      from(`gh pr create --draft -B dev -H feat --title 'fix: a; b' --body-file "b.md"`),
      ALLOWED,
    );
    // Anything but one plain create could reach back into the guarded repository.
    assert.equal(from('gh pr create -R other/repo --head feat'), DENIED);
    assert.equal(from('gh pr create -R o/r --head unverified'), DENIED);
    assert.equal(from('gh pr create -R other/repo -R github.com/O/R.git --head x'), DENIED);
    assert.equal(from('gh -R other/repo pr create --repo=o/r/ -H x'), DENIED);
    assert.equal(from('GH_REPO=o/r gh pr create -H x'), DENIED);
    assert.equal(from(`cd ${repo} && gh pr create -H unverified`), DENIED);
    assert.equal(from('cd "$PWD" && gh pr create -H x'), DENIED);
    assert.equal(from('pushd /tmp; glab mr new -s x'), DENIED);
    assert.equal(from('gh api repos/o/r/pulls -f head=x -f base=dev'), DENIED);
    assert.equal(
      from("gh api graphql -f query='mutation { createPullRequest(input: {}) { x } }'"),
      DENIED,
    );
    assert.equal(from('git push -o merge_request.create'), DENIED);
    assert.equal(from(`git -C ${repo} push -o merge_request.create`), DENIED);
    assert.equal(from(`GIT_DIR=${repo}/.git gh pr create -H x`), DENIED);
    assert.equal(from(`chdir ${repo} && gh pr create -H x`), DENIED);
    assert.equal(from('export GH_REPO=o/r; gh pr create -H x'), DENIED);
    assert.equal(from('R=o/r; gh pr create -R $R -H x'), DENIED);
    assert.equal(from('gh pr create -R "$(echo o/r)" -H x'), DENIED);
    assert.equal(from(`sh -c 'cd ${repo} && gh pr create -H x'`), DENIED);
    assert.equal(from('eval "gh pr create -H x"'), DENIED);
    assert.equal(from('gh pr create -R "o"/r -H x'), DENIED);
    assert.equal(from('gh pr create --repo=o/{r,} -H x'), DENIED);
    assert.equal(from('\\cd ../r && gh pr create -H x'), DENIED);
    assert.equal(from('env --chdir=../r gh pr create -H x'), DENIED);
    assert.equal(from("dash -c 'gh pr create -H x'"), DENIED);
    assert.equal(from('gh pr create -H x\ngh pr create -H y'), DENIED);
    assert.equal(from('gh pr create --title "$(id)" -H x'), DENIED);
    assert.equal(from('gh pr create -"R" o/r -H x'), DENIED);
    assert.equal(from("gh pr create -''R o/r -H x"), DENIED);
    assert.equal(from('gh pr create --re""po=o/r -H x'), DENIED);
    assert.equal(from('gh pr create -H x "-R" o/r'), DENIED);
    assert.equal(from("gh pr create -H x '--repo' o/r"), DENIED);
    const fromHere = (command, home = process.env.HOME) =>
      spawnSync('node', [guard], {
        cwd: repo,
        env: { ...process.env, HOME: home },
        input: JSON.stringify({ tool_input: { command }, cwd: repo }),
      }).status;
    assert.equal(fromHere(`cd ${other} && gh pr create --draft --base dev --head feat`), ALLOWED);
    assert.equal(fromHere(`cd "${other}" && glab mr create --fill --yes`), ALLOWED);
    assert.equal(
      fromHere(`cd ~/${basename(other)} && glab mr create --fill`, dirname(other)),
      ALLOWED,
    );
    assert.equal(fromHere(`cd ${other} && gh pr create -R o/r -H unverified`), DENIED);
    assert.equal(fromHere(`cd ${other} && gh pr create -H x; gh pr create -H unverified`), DENIED);
    assert.equal(fromHere(`cd ${other} && cd ${repo} && gh pr create -H unverified`), DENIED);
    assert.equal(fromHere(`cd ${other}/missing && gh pr create -H x`), DENIED);
    assert.equal(fromHere(`cd "~/${basename(other)}" && gh pr create -H unverified`), DENIED);
    assert.equal(fromHere(`cd ${repo} && gh pr create -H unverified`), DENIED);
    // A rewrite that sends the other checkout's own remote here.
    execFileSync(
      'git',
      ['config', 'url.git@github.com:o/r.git.insteadOf', 'https://github.com/other/repo.git'],
      { cwd: other },
    );
    assert.equal(from('gh pr create --draft --base dev --head feat'), DENIED);
    execFileSync('git', ['config', '--unset', 'url.git@github.com:o/r.git.insteadOf'], {
      cwd: other,
    });
    assert.equal(from('gh pr create --draft --base dev --head feat'), ALLOWED);
    // A remote that gh would decode or normalise into this repository.
    for (const url of [
      'https://github.com/o/r?x=1',
      'https://github.com/o%2Fr',
      'https://github.com/O/R.GIT',
      'https://github.com/other/repo git@github.com:o/r.git',
    ]) {
      execFileSync('git', ['remote', 'add', 'odd', url], { cwd: other });
      assert.equal(from('gh pr create --draft --base dev --head feat'), DENIED, url);
      execFileSync('git', ['remote', 'remove', 'odd'], { cwd: other });
    }
    // A remote of the other checkout pointing here sends even a plain create here.
    execFileSync('git', ['remote', 'add', 'upstream', 'https://github.com/o/r'], { cwd: other });
    assert.equal(from('gh pr create --draft --base dev --head feat'), DENIED);
  } finally {
    rmSync(other, { recursive: true, force: true });
  }
});
