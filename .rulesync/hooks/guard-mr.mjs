#!/usr/bin/env node
// PreToolUse guard: no merge/pull request until `pnpm verify` passed on the commit being sent.
// `pnpm verify` ends with `node .rulesync/hooks/guard-mr.mjs --stamp`, which records HEAD in
// node_modules/.cache/verify-head when the tree is clean; a `--stamp` outside the verify script is
// refused. Opening an MR/PR (CLI, push option, REST or GraphQL) is denied unless that record matches
// the current HEAD of a clean tree. Git errors fail open, like every other guard.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deny, extractCommand, readPayload } from './_shared.mjs';

const OPENS_REVIEW =
  /\b(?:glab\s+mr\s+create|gh\s+pr\s+create|createPullRequest|mergeRequestCreate)\b|merge_request\.create/;
const API_CALL = /\b(?:gh|glab)\s+api\b/;
const REVIEW_COLLECTION = /\/(?:pulls|merge_requests)(?=["'\s?]|$)/;
// `gh api` and `glab api` default to POST once a field or body is passed.
const WRITES = /\s(?:(?:-X\s*|--method[=\s]+)POST\b|(?:-f|-F|--field|--raw-field|--input)\b)/i;
const READS = /\s(?:-X\s*|--method[=\s]+)GET\b/i;

const opensReview = (command) =>
  OPENS_REVIEW.test(command) ||
  (API_CALL.test(command) &&
    REVIEW_COLLECTION.test(command) &&
    WRITES.test(command) &&
    !READS.test(command));

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
  if (process.env.npm_lifecycle_event !== 'verify') {
    process.stderr.write('--stamp is recorded by `pnpm verify` only: run `pnpm verify`.\n');
    process.exit(1);
  }
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
if (!opensReview(extractCommand(payload))) {
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
