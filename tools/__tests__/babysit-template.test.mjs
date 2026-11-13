// babysit.mjs --once against a fake `gh`: a green draft asks to be marked ready, a thread with a
// drafted reply stays quiet until a new comment lands, and a live session holding the PR wins.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../templates/consumer/__dot__rulesync/skills/babysit/babysit.mjs', import.meta.url),
);
const repo = mkdtempSync(join(tmpdir(), 'babysit-'));
const bin = join(repo, 'bin');
const sleepers = [];
after(() => {
  for (const sleeper of sleepers) {
    sleeper.kill();
  }
  rmSync(repo, { recursive: true, force: true });
});

execFileSync('git', ['init', '-q', repo]);
execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git']);
mkdirSync(bin);
// The fake answers `gh pr view` from pr.json and `gh api graphql` from threads.json
writeFileSync(
  join(bin, 'gh'),
  `#!/bin/sh\ncase "$1" in pr) cat "${repo}/pr.json" ;; api) cat "${repo}/threads.json" ;; esac\n`,
);
chmodSync(join(bin, 'gh'), 0o755);

const pr = (fields) =>
  writeFileSync(
    join(repo, 'pr.json'),
    JSON.stringify({
      number: 7,
      url: 'https://github.com/o/r/pull/7',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'feat/x',
      mergeable: 'MERGEABLE',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }],
      ...fields,
    }),
  );
const threads = (lastCommentIds) =>
  writeFileSync(
    join(repo, 'threads.json'),
    JSON.stringify([
      {
        data: {
          viewer: { login: 'me' },
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: lastCommentIds.map((id) => ({
                  isResolved: false,
                  comments: { nodes: [{ id, author: { login: 'reviewer' } }] },
                })),
              },
              comments: { nodes: [] },
            },
          },
        },
      },
    ]),
  );
const once = () =>
  execFileSync(process.execPath, [SCRIPT, '7', '--once'], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }).trim();

test('a green PR has nothing to do, a green draft asks to be marked ready, red wins', () => {
  threads([]);
  pr({});
  assert.equal(once(), 'none');
  pr({ isDraft: true });
  assert.equal(once(), 'green');
  pr({ statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE' }] });
  assert.equal(once(), 'failed');
  pr({ mergeable: 'CONFLICTING' });
  assert.equal(once(), 'conflicts');
});

test('a thread with a drafted reply stays quiet until a new comment changes its last id', () => {
  pr({});
  threads(['c1', 'c2']);
  assert.equal(once(), 'threads c1 c2');
  mkdirSync(join(repo, '.claude/reviews'), { recursive: true });
  writeFileSync(join(repo, '.claude/reviews/feat+x.drafted.json'), JSON.stringify(['c1', 'c2']));
  assert.equal(once(), 'none');
  threads(['c1', 'c3']);
  assert.equal(once(), 'threads c3');
});

test('a PR held by a live session reads watched; a dead holder does not count', () => {
  pr({});
  threads([]);
  const sleeper = spawn('sleep', ['30']);
  sleepers.push(sleeper);
  mkdirSync(join(repo, '.git/babysit'), { recursive: true });
  writeFileSync(join(repo, '.git/babysit/7.pid'), String(sleeper.pid));
  assert.equal(once(), 'watched');
  writeFileSync(join(repo, '.git/babysit/7.pid'), '999999');
  assert.equal(once(), 'none');
});
