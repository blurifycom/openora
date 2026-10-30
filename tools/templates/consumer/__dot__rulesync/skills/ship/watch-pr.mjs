#!/usr/bin/env node
// Watches the MR or PR of a branch and prints one line, then exits, when ship has work on it:
//   failed | conflicts | threads <ids> | green (only with --until-green) | merged | closed | error <message>
// A thread waits for an answer until its last comment is an "Agent:" reply from the account this runs as
// (anyone can type the prefix); it is reported once it stayed the same for two checks, so a review with
// ten comments is one line. Run it in the background:
//   node watch-pr.mjs <branch> [--until-green]        WATCH_DEBUG=1 prints every check to stderr
// --once checks one time, for a caller that polls on its own (a scheduler): threads are reported at
// once, and `none` means nothing to do.
import { execFileSync } from 'node:child_process';

const EVERY_MS = 120_000;
// ponytail: a repo with no CI on the last commit reads green after this; a head-SHA match on checks if it matters
const NO_CI_MS = 10 * 60_000;
const MAX_ERRORS = 5;
const AGENT_REPLY = 'Agent:';
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

const [branch, ...flags] = process.argv.slice(2);
if (!branch) {
  console.error('usage: watch-pr.mjs <branch> [--until-green | --once]');
  process.exit(2);
}
const untilGreen = flags.includes('--until-green');
const once = flags.includes('--once');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const json = (cmd, args) => JSON.parse(run(cmd, args));
const unansweredIds = (lastComments, me) =>
  lastComments
    .filter(
      (comment) => !(comment.author === me && comment.body.trimStart().startsWith(AGENT_REPLY)),
    )
    .map((comment) => String(comment.id))
    .sort();

const THREADS = `query($owner: String!, $name: String!, $number: Int!, $endCursor: String) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100, after: $endCursor) {
      nodes { isResolved comments(last: 1) { nodes { id body author { login } } } }
      pageInfo { hasNextPage endCursor }
    }
    comments(last: 1) { nodes { id body author { login } } }
  } }
}`;

function github() {
  const pr = json('gh', [
    'pr',
    'view',
    branch,
    '--json',
    'number,url,state,mergeable,statusCheckRollup',
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
    state: pr.state.toLowerCase(),
    conflicts: pr.mergeable === 'CONFLICTING',
    ci,
    unanswered: unansweredIds(open, pages[0].viewer.login),
  };
}

function gitlab() {
  const mr = json('glab', ['mr', 'view', branch, '-F', 'json']);
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
  return { state, conflicts: mr.has_conflicts === true, ci, unanswered: unansweredIds(open, me) };
}

const say = (line) => {
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
    if (now.state !== 'open') say(now.state);
    if (now.conflicts) say('conflicts');
    if (now.ci === 'failed') say('failed');
    const ids = now.unanswered.join(' ');
    if (ids && (once || ids === seen)) say(`threads ${ids}`);
    seen = ids;
    const green = now.ci === 'passed' || (now.ci === null && Date.now() - started >= NO_CI_MS);
    if (untilGreen && green && !ids) say('green');
    if (once) say('none');
  } catch (reason) {
    if (once || ++errors >= MAX_ERRORS)
      say(`error ${reason instanceof Error ? reason.message.split('\n')[0] : reason}`);
  }
  await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
}
