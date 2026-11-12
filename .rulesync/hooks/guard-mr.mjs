#!/usr/bin/env node
// PreToolUse guard: no merge/pull request until `pnpm verify` passed on the commit being sent.
// A full `pnpm verify` run (no extra arguments) ends with `node .rulesync/hooks/guard-mr.mjs
// --stamp`, which records HEAD in node_modules/.cache/verify-head when the tree is clean; a
// `--stamp` outside the verify script is refused. Opening an MR/PR (CLI, push option, REST or
// GraphQL) is denied unless that record matches the commit it sends: the named source branch
// (`--source-branch`, `--head`), else HEAD of a clean tree. A promotion from a shared branch was
// verified by that branch's pipeline and passes. Git errors fail open, like every other guard.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deny, extractCommand, readPayload } from './_shared.mjs';

const SHARED = /^(?:origin\/)?(?:main|master|dev|develop|stage|staging|prod|production)$/;
const OPENS_REVIEW = /\b(?:glab\s+mr\s+create|gh\s+pr\s+create)\b|merge_request\.create/;
// GraphQL mutations live in a quoted query, so they are matched on the raw command of an API call.
const GRAPHQL_CREATE = /\b(?:createPullRequest|mergeRequestCreate)\b/;
const API_CALL = /\b(?:gh|glab)\s+api\b/;
const REVIEW_COLLECTION = /\/(?:pulls|merge_requests)(?=["'\s?]|$)/;
// `gh api` and `glab api` default to POST once a field or body is passed.
const WRITES = /\s(?:(?:-X\s*|--method[=\s]+)POST\b|(?:-f|-F|--field|--raw-field|--input)\b)/i;
const READS = /\s(?:-X\s*|--method[=\s]+)GET\b/i;
const SOURCE = /\s(?:--head|-H|--source-branch|-s)(?:=|\s+)['"]?([^\s'"]+)/;

// Quoted prose (a title, a search pattern) is blanked so a command named inside it never counts;
// a quoted single word (a branch) is kept.
const blankProse = (command) =>
  command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) => (/\s/.test(quoted) ? '""' : quoted));

const opensReview = (raw, command) =>
  OPENS_REVIEW.test(command) ||
  (API_CALL.test(command) &&
    (GRAPHQL_CREATE.test(raw) ||
      (REVIEW_COLLECTION.test(raw) && WRITES.test(command) && !READS.test(command))));

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

const branchCommit = (root, branch) => {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    try {
      return git(root, 'rev-parse', '--verify', '-q', `${ref}^{commit}`);
    } catch {
      // try the next ref
    }
  }
  return '';
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
const raw = extractCommand(payload);
const command = blankProse(raw);
if (!opensReview(raw, command)) {
  process.exit(0);
}
// `gh pr create --head owner:branch` names the fork too.
const source = SOURCE.exec(command)?.[1].replace(/^[^:]+:/, '');
if (source && SHARED.test(source)) {
  process.exit(0);
}
const state = checkout(payload.cwd ?? process.cwd());
if (!state) {
  process.exit(0);
}
const sent = source ? branchCommit(state.root, source) : state.head;
const readStamp = () => {
  try {
    return readFileSync(stampFile(state.root), 'utf8').trim();
  } catch {
    return '';
  }
};
// Only the checked-out commit can carry uncommitted edits.
if (!sent || (sent === state.head && !state.isClean) || readStamp() !== sent) {
  deny(
    'Blocked: run `pnpm verify` (no extra arguments) on a clean checkout of the commit this merge/pull request sends. It records the verified commit; this check compares it with that commit.',
  );
}
process.exit(0);
