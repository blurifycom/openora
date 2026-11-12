#!/usr/bin/env node
// PreToolUse guard: no push and no new merge/pull request until the `review` skill approved HEAD.
// `review` (and `ship`, which runs it) saves `.claude/reviews/<pr or branch>.json` in the main
// checkout with the reviewed `sha` and the `verdict`. A push, `gh stack submit|push`, or a new
// MR/PR is denied unless one of those files records the current HEAD as APPROVED (or GO).
// Each command in a chain is judged on its own: a branch delete or a tag-only push passes, and
// so does a promotion, sent from a shared branch that no branch review covers. Git errors fail
// open, like every other guard.
//
// ponytail: trusts the state file, which an agent could write by hand, and checks the checked-out
// HEAD, not a different ref named on the command line. It stops a forgotten review, not a hostile
// one; the forge's own AI review is the gate an agent cannot write.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { deny, extractCommand, readPayload } from './_shared.mjs';

const SHARED = /^(?:origin\/)?(?:main|master|dev|develop|stage|staging|prod|production)$/;
const PREFIX = String.raw`^(?:(?:env\s+)?\w+=\S*\s+)*`;
const GIT_PUSH = new RegExp(`${PREFIX}git((?:\\s+(?:-[cC]\\s+\\S+|--\\S+))*)\\s+push\\b(.*)$`);
const OPENS_REVIEW = new RegExp(
  `${PREFIX}(?:gh(?:\\s+(?:-R|--repo)\\s+\\S+)?\\s+(?:pr\\s+create|stack\\s+(?:submit|push))|glab\\s+mr\\s+create)\\b(.*)$`,
);
const SOURCE = /\s(?:--head|-H|--source-branch|-s)(?:=|\s+)(\S+)/;
const DIR_FLAG = /\s-C\s+(\S+)/;

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

const unquote = (path) =>
  path.replace(/^['"]|['"]$/g, '').replace(/^~(?=\/)/, process.env.HOME ?? '~');
const within = (cwd, path) => {
  const dir = unquote(path);
  return isAbsolute(dir) ? dir : resolve(cwd, dir);
};

// Quoted prose (commit messages, PR bodies) is blanked so a flag or command inside it never
// counts; a quoted single word (a path, a branch) is kept.
const segments = (command) =>
  command
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, (quoted) => (/[\s;&|(){}]/.test(quoted) ? '""' : quoted))
    .split(/&&|\|\||[;|\n(){}]/)
    .map((part) => part.trim())
    .filter(Boolean);

const sendsNothingNew = (pushArgs) => {
  const args = pushArgs.trim().split(/\s+/).filter(Boolean);
  const refs = args.filter((arg) => !arg.startsWith('-')).slice(1);
  return (
    args.some((arg) => arg === '--delete' || arg === '-d') ||
    (refs.length > 0 && refs.every((ref) => ref.startsWith(':'))) ||
    (args.includes('--tags') && refs.length === 0)
  );
};

// Returns the directory to check, or null when the segment sends nothing that needs a review.
const reviewTarget = (segment, cwd) => {
  if (/^cd\s/.test(segment)) {return null;}
  const push = GIT_PUSH.exec(segment);
  if (push) {
    if (sendsNothingNew(push[2])) {return null;}
    const dir = DIR_FLAG.exec(push[1]);
    return dir ? within(cwd, dir[1]) : cwd;
  }
  const opens = OPENS_REVIEW.exec(segment);
  if (!opens) {return null;}
  const source = SOURCE.exec(opens[1]);
  return source && SHARED.test(unquote(source[1])) ? null : cwd;
};

const isApproved = (dirs, head) =>
  dirs.some((dir) => {
    try {
      const reviews = join(dir, '.claude', 'reviews');
      if (!existsSync(reviews)) {return false;}
      return readdirSync(reviews)
        .filter((name) => name.endsWith('.json'))
        .some((name) => {
          try {
            const state = JSON.parse(readFileSync(join(reviews, name), 'utf8'));
            const sha = String(state.sha ?? '').toLowerCase();
            return (
              /^[0-9a-f]{7,40}$/.test(sha) &&
              head.startsWith(sha) &&
              /^(?:APPROVED|GO\b)/i.test(String(state.verdict ?? ''))
            );
          } catch {
            return false;
          }
        });
    } catch {
      return false;
    }
  });

const check = (dir) => {
  const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  const top = git(dir, 'rev-parse', '--show-toplevel');
  const common = git(dir, 'rev-parse', '--git-common-dir');
  const head = git(dir, 'rev-parse', 'HEAD');
  if (!top || !common || !head || SHARED.test(branch)) {return;}
  const mainCheckout = dirname(isAbsolute(common) ? common : resolve(dir, common));
  if (!isApproved([...new Set([top, mainCheckout])], head)) {
    deny(
      `Blocked: no APPROVED review of HEAD ${head.slice(0, 9)}. Run \`ship\` for a ticket, or the \`review\` skill on this branch until it says APPROVED, then push. A person can still push from their own terminal.`,
    );
  }
};

const payload = readPayload();
let cwd = payload.cwd ?? process.cwd();
for (const segment of segments(extractCommand(payload))) {
  const cd = /^cd\s+(\S+)$/.exec(segment);
  if (cd) {cwd = within(cwd, cd[1]);}
  const dir = reviewTarget(segment, cwd);
  if (dir) {check(dir);}
}
process.exit(0);
