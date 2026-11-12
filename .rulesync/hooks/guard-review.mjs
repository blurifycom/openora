#!/usr/bin/env node
// PreToolUse guard: no push and no new merge/pull request until the `review` skill approved HEAD.
// `review` (and `ship`, which runs it) saves `.claude/reviews/<pr or branch>.json` in the main
// checkout with the reviewed `sha` and the `verdict`. A push, `gh stack submit|push`, or a new
// MR/PR is denied unless one of those files records the current HEAD as APPROVED (or GO). Branch
// deletes and tag pushes pass. Git errors fail open, like every other guard.
//
// ponytail: trusts the state file, which an agent could write by hand. It stops a forgotten
// review, not a hostile one; the forge's own AI review is the gate an agent cannot write.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { deny, extractCommand, readPayload } from './_shared.mjs';

const SENDS =
  /(?:^|[;&|\n(]\s*)(?:git(?:\s+-C\s+\S+)?\s+push|gh\s+pr\s+create|gh\s+stack\s+(?:submit|push)|glab\s+mr\s+create)\b/;
const NOTHING_TO_REVIEW =
  /\sgit(?:\s+-C\s+\S+)?\s+push\b.*\s(?:--delete|-d|--tags)\b|\spush\s+\S+\s+:\S/;
const GIT_C = /\bgit\s+-C\s+(\S+)\s+push\b/;
const CD = /^\s*cd\s+(\S+)\s*&&/;

const git = (cwd, ...args) => {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

const targetDir = (command, cwd) => {
  const match = GIT_C.exec(command) ?? CD.exec(command);
  if (!match) {return cwd;}
  const path = match[1].replace(/^['"]|['"]$/g, '').replace(/^~(?=\/)/, process.env.HOME ?? '~');
  return isAbsolute(path) ? path : resolve(cwd, path);
};

const isApproved = (dirs, head) =>
  dirs.some((dir) => {
    const reviews = join(dir, '.claude', 'reviews');
    if (!existsSync(reviews)) {return false;}
    return readdirSync(reviews)
      .filter((name) => name.endsWith('.json'))
      .some((name) => {
        try {
          const state = JSON.parse(readFileSync(join(reviews, name), 'utf8'));
          return (
            String(state.sha ?? '').startsWith(head) &&
            /^(?:APPROVED|GO\b)/i.test(String(state.verdict ?? ''))
          );
        } catch {
          return false;
        }
      });
  });

const payload = readPayload();
const command = extractCommand(payload);
if (!SENDS.test(command) || NOTHING_TO_REVIEW.test(` ${command}`)) {
  process.exit(0);
}
const cwd = targetDir(command, payload.cwd ?? process.cwd());
const top = git(cwd, 'rev-parse', '--show-toplevel');
const common = git(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const head = git(cwd, 'rev-parse', 'HEAD');
if (!top || !common || !head) {
  process.exit(0);
}
if (!isApproved([...new Set([top, dirname(common)])], head)) {
  deny(
    `Blocked: no APPROVED review of HEAD ${head.slice(0, 9)}. Run \`ship\` for a ticket, or the \`review\` skill on this branch until it says APPROVED, then push. A person can still push from their own terminal.`,
  );
}
process.exit(0);
