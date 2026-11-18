#!/usr/bin/env node
// PreToolUse guard: no merge/pull request until `pnpm verify` passed on the commit being sent.
// A full `pnpm verify` run (no extra arguments) ends with `node .rulesync/hooks/guard-mr.mjs
// --stamp`, which records HEAD in node_modules/.cache/verify-head when the tree is clean; a
// `--stamp` outside the verify script is refused. Opening an MR/PR (CLI, push option, REST or
// GraphQL) is denied unless that record matches the commit it sends: the named source branch
// (`--source-branch`, `--head`), else HEAD of a clean tree. A promotion from a shared branch was
// verified by that branch's pipeline and passes. Every create in a chain is checked, and one that
// names two different source branches is denied. Git errors fail open, like every other guard.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { deny, extractCommand, readPayload } from './_shared.mjs';

const SHARED = /^(?:origin\/)?(?:main|master|dev|develop|stage|staging|prod|production)$/;
// `-R <repo>` goes before or after `pr`/`mr`; `new` is an alias of `create`.
const REPO = String.raw`(?:\s+(?:-R\s*|--repo(?:=|\s+))\S+)?`;
const CLI_CREATE = new RegExp(
  String.raw`\b(?:(gh)${REPO}\s+(?:pr${REPO}\s+(?:create|new)|stack\s+(?:submit|push))|(glab)${REPO}\s+mr${REPO}\s+(?:create|new))\b([^;&|\n]*)`,
  'g',
);
const PUSH_OPTION_CREATE = /merge_request\.create/;
// GraphQL mutations live in a quoted query, so they are matched on the raw command of an API call.
const GRAPHQL_CREATE = /\b(?:createPullRequest|mergeRequestCreate)\b/;
const API_CALL = /\b(?:gh|glab)\s+api\b/;
const REVIEW_COLLECTION = /\/(?:pulls|merge_requests)(?=["'\s?]|$)/;
// `gh api` and `glab api` default to POST once a field or body is passed.
const WRITES = /\s(?:(?:-X\s*|--method[=\s]+)POST\b|(?:-f|-F|--field|--raw-field|--input)\b)/i;
const READS = /\s(?:-X\s*|--method[=\s]+)GET\b/i;
// The source branch flag, glued (`-Hfeat/x`, `-dH x`) or not. glab's `-H` names the head repository.
const SOURCE_FLAG = {
  gh: /\s(?:--head(?:=|\s+)|-[defw]*H(?:=|\s*))['"]?([^\s'"]+)/g,
  glab: /\s(?:--source-branch(?:=|\s+)|-[fwy]*s(?:=|\s*))['"]?([^\s'"]+)/g,
};

// Quoted prose (a title, a search pattern) or a quoted separator is blanked so a command named
// inside it never counts and never cuts a flag list short; a quoted single word (a branch) is kept.
const blankProse = (command) =>
  command.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) =>
    /[\s;&|(){}]/.test(quoted) ? '""' : quoted,
  );

// A push option or an API call opens the MR/PR from HEAD.
const opensFromHead = (raw, command) =>
  PUSH_OPTION_CREATE.test(command) ||
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
// The source branch of each create in the chain, `undefined` for HEAD; `gh pr create --head
// owner:branch` names the fork too. A create naming two different ones is ambiguous.
const sources = [...command.matchAll(CLI_CREATE)].map((create) => {
  const named = [
    ...new Set(
      [...create[3].matchAll(SOURCE_FLAG[create[1] ?? create[2]])].map((flag) =>
        flag[1].replace(/^[^:]+:/, ''),
      ),
    ),
  ];
  if (named.length > 1) {
    deny(
      `Blocked: this command names more than one source branch (${named.join(', ')}); name one.`,
    );
  }
  return named[0];
});
if (opensFromHead(raw, command)) {
  sources.push(undefined);
}
const pending = sources.filter((source) => !source || !SHARED.test(source));
if (pending.length === 0) {
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
const stamp = readStamp();
for (const source of pending) {
  const sent = source ? branchCommit(state.root, source) : state.head;
  // Only the checked-out commit can carry uncommitted edits.
  if (!sent || (sent === state.head && !state.isClean) || stamp !== sent) {
    deny(
      'Blocked: run `pnpm verify` (no extra arguments) on a clean checkout of the commit this merge/pull request sends. It records the verified commit; this check compares it with that commit.',
    );
  }
}
process.exit(0);
