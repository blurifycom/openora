#!/usr/bin/env node
// PreToolUse guard: no merge/pull request until `pnpm verify` passed on the commit being sent.
// `pnpm verify` ends with `node .rulesync/hooks/guard-mr.mjs --stamp`, which records HEAD in
// node_modules/.cache/verify-head when the tree is clean. Opening an MR/PR is denied unless that
// record matches the current HEAD of a clean tree. Git errors fail open, like every other guard.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deny, extractCommand, readPayload } from './_shared.mjs';

const OPENS_REVIEW = /\b(?:glab\s+mr\s+create|gh\s+pr\s+create)\b|merge_request\.create/;

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const stampFile = (root) => join(root, 'node_modules', '.cache', 'verify-head');

const checkout = (cwd) => {
  try {
    const root = git(cwd, 'rev-parse', '--show-toplevel');
    return {
      root,
      head: git(root, 'rev-parse', 'HEAD'),
      isClean: git(root, 'status', '--porcelain') === '',
    };
  } catch {
    return undefined;
  }
};

if (process.argv.includes('--stamp')) {
  const state = checkout(process.cwd());
  if (state?.isClean) {
    mkdirSync(dirname(stampFile(state.root)), { recursive: true });
    writeFileSync(stampFile(state.root), state.head);
  } else {
    process.stderr.write(
      'verify passed on uncommitted changes: commit, then rerun `pnpm verify` before opening an MR/PR.\n',
    );
  }
  process.exit(0);
}

const payload = readPayload();
if (!OPENS_REVIEW.test(extractCommand(payload))) {
  process.exit(0);
}
const state = checkout(payload.cwd ?? process.cwd());
if (!state) {
  process.exit(0);
}
const readStamp = () => {
  try {
    return readFileSync(stampFile(state.root), 'utf8').trim();
  } catch {
    return '';
  }
};
if (!state.isClean || readStamp() !== state.head) {
  deny(
    'Blocked: run `pnpm verify` on a clean, committed HEAD before opening a merge/pull request. It records the verified commit; this check compares it with HEAD.',
  );
}
process.exit(0);
