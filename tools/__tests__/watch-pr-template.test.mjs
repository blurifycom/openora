// watch-pr.mjs reports a review thread until the account it runs as left a final reaction on it:
// eyes only means picked up, so it stays pending. Runs the script with a fake `git` and `gh`.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(
  new URL('../templates/consumer/__dot__rulesync/skills/ship/watch-pr.mjs', import.meta.url),
);

const run = (reactions) => {
  const bin = mkdtempSync(join(tmpdir(), 'watch-pr-'));
  const page = {
    data: {
      viewer: { login: 'agent' },
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                isResolved: false,
                comments: {
                  nodes: [
                    {
                      id: 'C1',
                      body: 'fix this',
                      author: { login: 'reviewer' },
                      reactions: { nodes: reactions },
                    },
                  ],
                },
              },
            ],
          },
          comments: { nodes: [] },
        },
      },
    },
  };
  const pr = {
    number: 1,
    url: 'https://github.com/o/r/pull/1',
    state: 'OPEN',
    mergeable: 'MERGEABLE',
  };
  writeFileSync(join(bin, 'git'), '#!/bin/sh\necho git@github.com:o/r.git\n');
  writeFileSync(
    join(bin, 'gh'),
    `#!/bin/sh\nif [ "$1" = pr ]; then echo '${JSON.stringify(pr)}'; else echo '${JSON.stringify([page])}'; fi\n`,
  );
  chmodSync(join(bin, 'git'), 0o755);
  chmodSync(join(bin, 'gh'), 0o755);
  return spawnSync('node', [SCRIPT, 'feat/x', '--once'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  }).stdout.trim();
};

const mine = (content) => ({ content, user: { login: 'agent' } });

test('a thread with no reaction is unanswered', () => {
  assert.equal(run([]), 'threads C1');
});
test('eyes only means picked up, still unanswered', () => {
  assert.equal(run([mine('EYES')]), 'threads C1');
});
test('a final reaction from someone else does not answer it', () => {
  assert.equal(run([{ content: 'THUMBS_UP', user: { login: 'other' } }]), 'threads C1');
});
test('thumbs up or confused from the agent answers it', () => {
  assert.equal(run([mine('EYES'), mine('THUMBS_UP')]), 'none');
  assert.equal(run([mine('CONFUSED')]), 'none');
});
