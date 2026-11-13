#!/usr/bin/env node
// Watches one MR or PR (branch or number) and prints one line, then exits, when babysit has work on it:
//   failed | conflicts | threads <ids> | green (with --until-green) | merged | closed | error <message>
// A thread waits for an answer until its last comment is from the account this runs as: agents never
// post, so that is the person replying by hand. It is reported once it stayed the same for two checks,
// so a review with ten comments is one line. A thread whose last-comment id is in
// .claude/reviews/<branch with / as +>.drafted.json in the main checkout has a drafted reply waiting
// for the person to post it; a new comment changes the id and reports the thread again.
// Run it in the background:
//   node babysit.mjs <branch|number> [--until-green]     WATCH_DEBUG=1 prints every check to stderr
// While it watches, <git common dir>/babysit/<number>.pid names its Claude session until the MR merges
// or closes, so a scheduler skips the MR while that session lives.
// --once checks one time, for a caller that polls on its own (a scheduler): threads are reported at
// once, `green` only for a draft (mark it ready), `watched` when a live session holds the MR, and
// `none` means nothing to do.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const EVERY_MS = 120_000;
// ponytail: a repo with no CI on the last commit reads green after this; a head-SHA match on checks if it matters
const NO_CI_MS = 10 * 60_000;
const MAX_ERRORS = 5;
const FAILED = [
  'FAILURE',
  'ERROR',
  'CANCELLED',
  'TIMED_OUT',
  'ACTION_REQUIRED',
  'STARTUP_FAILURE',
  'failed',
  'canceled',
];

const [target, ...flags] = process.argv.slice(2);
if (!target) {
  console.error('usage: babysit.mjs <branch|number> [--until-green | --once]');
  process.exit(2);
}
const untilGreen = flags.includes('--until-green');
const once = flags.includes('--once');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const json = (cmd, args) => JSON.parse(run(cmd, args));
const commonDir = run('git', ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
const mainCheckout = basename(commonDir) === '.git' ? dirname(commonDir) : commonDir;

const draftedIds = (branch) => {
  try {
    const file = join(
      mainCheckout,
      '.claude/reviews',
      `${branch.replaceAll('/', '+')}.drafted.json`,
    );
    return new Set(JSON.parse(readFileSync(file, 'utf8')).map(String));
  } catch {
    return new Set();
  }
};
const unansweredIds = (lastComments, me, branch) => {
  const drafted = draftedIds(branch);
  return lastComments
    .filter((comment) => comment.author !== me)
    .map((comment) => String(comment.id))
    .filter((id) => !drafted.has(id))
    .sort();
};

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $endCursor) {
      nodes { isResolved comments(last: 1) { nodes { id author { login } } } }
      pageInfo { hasNextPage endCursor }
    }
    comments(last: 1) { nodes { id author { login } } }
  } }
}`;

function github() {
  const pr = json('gh', [
    'pr',
    'view',
    target,
    '--json',
    'number,url,state,isDraft,headRefName,mergeable,statusCheckRollup',
  ]);
  const [, owner, name] = new URL(pr.url).pathname.split('/');
  const args = [
    'api',
    'graphql',
    '--paginate',
    '--slurp',
    '-f',
    `query=${THREADS}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${pr.number}`,
  ];
  const pages = json('gh', args).map((page) => page.data);
  const open = pages
    .flatMap(({ repository }) => repository.pullRequest.reviewThreads.nodes)
    .filter((thread) => !thread.isResolved)
    .flatMap((thread) => thread.comments.nodes)
    .concat(pages[0].repository.pullRequest.comments.nodes)
    .map((comment) => ({ ...comment, author: comment.author?.login }));
  const checks = pr.statusCheckRollup ?? [];
  const ci = !checks.length
    ? null
    : checks.some((check) => FAILED.includes(check.conclusion || check.state))
      ? 'failed'
      : checks.some((check) =>
            check.status
              ? check.status !== 'COMPLETED'
              : check.state === 'PENDING' || check.state === 'EXPECTED',
          )
        ? 'running'
        : 'passed';
  return {
    number: pr.number,
    state: pr.state.toLowerCase(),
    draft: pr.isDraft,
    conflicts: pr.mergeable === 'CONFLICTING',
    ci,
    unanswered: unansweredIds(open, pages[0].viewer.login, pr.headRefName),
  };
}

function gitlab() {
  const mr = json('glab', ['mr', 'view', target, '-F', 'json']);
  const discussions = run('glab', [
    'api',
    '--paginate',
    '--output',
    'ndjson',
    `projects/${mr.project_id}/merge_requests/${mr.iid}/discussions?per_page=100`,
  ])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const open = discussions
    .map((discussion) => discussion.notes.filter((note) => !note.system))
    .filter(
      (notes) =>
        notes.length &&
        !(
          notes.some((note) => note.resolvable) &&
          notes.every((note) => !note.resolvable || note.resolved)
        ),
    )
    .map((notes) => notes.at(-1))
    .map((note) => ({ ...note, author: note.author?.username }));
  const pipeline = mr.head_pipeline?.sha === mr.sha ? mr.head_pipeline.status : null;
  const ci = !pipeline
    ? null
    : FAILED.includes(pipeline)
      ? 'failed'
      : ['success', 'skipped', 'manual'].includes(pipeline)
        ? 'passed'
        : 'running';
  const state = mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed';
  const me = json('glab', ['api', 'user']).username;
  return {
    number: mr.iid,
    state,
    draft: mr.draft === true,
    conflicts: mr.has_conflicts === true,
    ci,
    unanswered: unansweredIds(open, me, mr.source_branch),
  };
}

// The lock names the Claude session this runs under, not this process: the watcher exits on every
// line of work, and the session still owns the MR while it fixes it. The session ending frees it.
// ponytail: a pid reused by an unrelated process after a crash reads as alive; the next reboot clears it
const sessionPid = (() => {
  let pid = process.ppid;
  for (let depth = 0; depth < 10 && pid > 1; depth++) {
    const [parent, ...command] = run('ps', ['-o', 'ppid=,comm=', '-p', String(pid)])
      .trim()
      .split(/\s+/);
    if (basename(command.join(' ')) === 'claude') return pid;
    pid = Number(parent);
  }
  return process.pid;
})();
const lockFile = (number) => join(commonDir, 'babysit', `${number}.pid`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
};
const heldByOther = (number) => {
  try {
    const pid = Number(readFileSync(lockFile(number), 'utf8'));
    return pid !== sessionPid && alive(pid);
  } catch {
    return false;
  }
};
let held = null;
const hold = (number) => {
  if (held === number) return;
  mkdirSync(dirname(lockFile(number)), { recursive: true });
  writeFileSync(lockFile(number), String(sessionPid));
  held = number;
};
const release = () => held !== null && rmSync(lockFile(held), { force: true });
process.on('exit', () => sessionPid === process.pid && release());
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0));

const say = (line) => {
  if (['merged', 'closed'].includes(line)) release();
  console.log(line);
  process.exit(0);
};
const status = /github\.com/.test(run('git', ['remote', 'get-url', 'origin'])) ? github : gitlab;
const started = Date.now();
let seen = null;
let errors = 0;
for (;;) {
  try {
    const now = status();
    errors = 0;
    if (process.env.WATCH_DEBUG) console.error(JSON.stringify(now));
    if (!once) hold(now.number);
    if (now.state !== 'open') say(now.state);
    if (once && heldByOther(now.number)) say('watched');
    if (now.conflicts) say('conflicts');
    if (now.ci === 'failed') say('failed');
    const ids = now.unanswered.join(' ');
    if (ids && (once || ids === seen)) say(`threads ${ids}`);
    seen = ids;
    const green = now.ci === 'passed' || (now.ci === null && Date.now() - started >= NO_CI_MS);
    if (untilGreen && green && !ids) say('green');
    if (once) say(now.ci === 'passed' && !ids && now.draft ? 'green' : 'none');
  } catch (reason) {
    if (once || ++errors >= MAX_ERRORS)
      say(`error ${reason instanceof Error ? reason.message.split('\n')[0] : reason}`);
  }
  await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
}
