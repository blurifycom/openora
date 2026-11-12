#!/usr/bin/env node
// PreToolUse guard: no push and no new merge/pull request until the `review` skill approved HEAD.
// `review` (and `ship`, which runs it) saves `.claude/reviews/<pr or branch>.json` in the main
// checkout with the reviewed `sha` and the `verdict`. A push, `gh stack submit|push`, or a new
// MR/PR is denied unless one of those files records the current HEAD as APPROVED (or GO).
// Each command in a chain is judged on its own: a branch delete or a tag-only push passes, and
// so does a PR/MR opened from a shared branch (a promotion, which no branch review covers). A
// push to a shared branch and a hand merge (`gh pr|stack merge`, `glab mr merge`) are denied
// outright: the merge bot merges. Git errors fail open, like every other guard.
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
// A forge CLI (`gh`/`glab`, bare, by path or behind `command`) and its words after that prefix.
const FORGE_CLI = new RegExp(`${PREFIX}(?:command\\s+)?(?:\\S*/)?(gh|glab)\\s+(.*)$`);
const MERGE_API = /\/merge(?=$|[?\s"'])/;
const API_WRITES =
  /\s(?:(?:-X\s*|--method[=\s]+)(?:PUT|POST)\b|(?:-f|-F|--field|--raw-field|--input)\b)/i;
// GraphQL merges live in a quoted query, which `segments` blanks, so the raw command is checked.
const GRAPHQL_MERGE = /\b(?:mergePullRequest|mergeRequestAccept|mergeQueue)\b/;
const isHandMerge = (segment) => {
  const cli = FORGE_CLI.exec(segment);
  if (!cli) {
    return false;
  }
  const words = cli[2].split(/\s+/);
  const command = words.findIndex((word) => /^(?:pr|stack|mr)$/.test(word));
  return (
    (command >= 0 && words.slice(command + 1).includes('merge')) ||
    (words.includes('api') && MERGE_API.test(cli[2]) && API_WRITES.test(` ${cli[2]}`))
  );
};
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
    .map((part) => part.replace(/(?:^|\s)#.*$/, '').trim())
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

// The directory to check and whether the segment opens a PR/MR, or null when it sends nothing
// that needs a review. A PR/MR opened from a shared branch is a promotion and needs none; a push
// from one does.
const reviewTarget = (segment, cwd) => {
  if (/^cd\s/.test(segment)) {
    return null;
  }
  const push = GIT_PUSH.exec(segment);
  if (push) {
    const dir = DIR_FLAG.exec(push[1]);
    return {
      dir: dir ? within(cwd, dir[1]) : cwd,
      opensReview: false,
      pushArgs: push[2],
      sendsNothingNew: sendsNothingNew(push[2]),
    };
  }
  const opens = OPENS_REVIEW.exec(segment);
  if (!opens) {
    return null;
  }
  const source = SOURCE.exec(opens[1]);
  if (source && SHARED.test(unquote(source[1]))) {
    return null;
  }
  return { dir: cwd, opensReview: true };
};

const isApproved = (dirs, head) =>
  dirs.some((dir) => {
    try {
      const reviews = join(dir, '.claude', 'reviews');
      if (!existsSync(reviews)) {
        return false;
      }
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

// The branches a push writes or deletes: each refspec's destination (`HEAD`/`@` is the checked-out
// branch, a glob may be any branch), or with no refspec where git sends this branch (`@{push}`,
// which follows push.default and remote.<name>.push). `--all` and `--mirror` write every branch.
const pushesShared = (dir, pushArgs, branch) => {
  if (/\s--(?:all|mirror)\b/.test(pushArgs)) {
    return true;
  }
  const args = pushArgs.trim().split(/\s+/).filter(Boolean);
  const refs = args
    .filter((arg) => !arg.startsWith('-'))
    .slice(1)
    .map(unquote);
  if (refs.length === 0) {
    if (args.includes('--tags')) {
      return false;
    }
    const destination = git(dir, 'rev-parse', '--abbrev-ref', '@{push}').replace(/^[^/]+\//, '');
    return SHARED.test(destination || branch);
  }
  return refs.some((spec) => {
    const destination = spec.replace(/^\+/, '').split(':').pop();
    return (
      destination.includes('*') ||
      SHARED.test(
        (/^(?:HEAD|@)$/.test(destination) ? branch : destination).replace(/^refs\/heads\//, ''),
      )
    );
  });
};

const check = ({ dir, opensReview, pushArgs, sendsNothingNew }) => {
  const branch = git(dir, 'rev-parse', '--abbrev-ref', 'HEAD');
  if (pushArgs !== undefined && branch && pushesShared(dir, pushArgs, branch)) {
    deny(
      'Blocked: nobody pushes to or deletes a shared branch by hand. Push a topic branch and open a merge/pull request; the merge bot merges it. A person can still push from their own terminal.',
    );
  }
  if (sendsNothingNew) {
    return;
  }
  const top = git(dir, 'rev-parse', '--show-toplevel');
  const common = git(dir, 'rev-parse', '--git-common-dir');
  const head = git(dir, 'rev-parse', 'HEAD');
  if (!top || !common || !head || (opensReview && SHARED.test(branch))) {
    return;
  }
  const mainCheckout = dirname(isAbsolute(common) ? common : resolve(dir, common));
  if (!isApproved([...new Set([top, mainCheckout])], head)) {
    deny(
      `Blocked: no APPROVED review of HEAD ${head.slice(0, 9)}. Run \`ship\` for a ticket, or the \`review\` skill on this branch until it says APPROVED, then push. A person can still push from their own terminal.`,
    );
  }
};

const payload = readPayload();
const rawCommand = extractCommand(payload);
let cwd = payload.cwd ?? process.cwd();
for (const segment of segments(rawCommand)) {
  const cd = /^cd\s+(\S+)$/.exec(segment);
  if (cd) {
    cwd = within(cwd, cd[1]);
  }
  if (isHandMerge(segment) || (/\b(?:gh|glab)\s/.test(segment) && GRAPHQL_MERGE.test(rawCommand))) {
    deny(
      'Blocked: the merge bot merges, never an agent. Leave the merge/pull request to it; a person who has to merge by hand runs it from their own terminal (`! <command>` in Claude Code).',
    );
  }
  const target = reviewTarget(segment, cwd);
  if (target) {
    check(target);
  }
}
process.exit(0);
