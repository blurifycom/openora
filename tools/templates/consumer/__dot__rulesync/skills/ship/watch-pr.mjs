#!/usr/bin/env node
// Watches the MR or PR of a branch and prints one line, then exits, when ship has work on it:
//   failed | conflicts | threads <ids> | green (only with --until-green) | merged | closed | error <message>
// A thread waits for an answer while its last comment doesn't start with "Agent:"; it is reported once it
// stayed the same for two checks, so a review with ten comments is one line. Run it in the background:
//   node watch-pr.mjs <branch> [--until-green]        WATCH_DEBUG=1 prints every check to stderr
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
  console.error('usage: watch-pr.mjs <branch> [--until-green]');
  process.exit(2);
}
const untilGreen = flags.includes('--until-green');

const run = (cmd, args) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const json = (cmd, args) => JSON.parse(run(cmd, args));
const unansweredIds = (lastComments) =>
  lastComments
    .filter((comment) => !comment.body.trimStart().startsWith(AGENT_REPLY))
    .map((comment) => String(comment.id))
    .sort();

const THREADS = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { id body } } } }
    comments(last: 1) { nodes { id body } }
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
    '-f',
    `query=${THREADS}`,
    '-f',
    `owner=${owner}`,
    '-f',
    `name=${name}`,
    '-F',
    `number=${pr.number}`,
  ];
  const { reviewThreads, comments } = json('gh', args).data.repository.pullRequest;
  const open = reviewThreads.nodes
    .filter((thread) => !thread.isResolved)
    .flatMap((thread) => thread.comments.nodes);
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
    unanswered: unansweredIds([...open, ...comments.nodes]),
  };
}

function gitlab() {
  const mr = json('glab', ['mr', 'view', branch, '-F', 'json']);
  // ponytail: first 100 discussions only; paginate if an MR ever gets more
  const discussions = json('glab', [
    'api',
    `projects/${mr.project_id}/merge_requests/${mr.iid}/discussions?per_page=100`,
  ]);
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
    .map((notes) => notes.at(-1));
  const pipeline = mr.head_pipeline?.sha === mr.sha ? mr.head_pipeline.status : null;
  const ci = !pipeline
    ? null
    : FAILED.includes(pipeline)
      ? 'failed'
      : ['success', 'skipped', 'manual'].includes(pipeline)
        ? 'passed'
        : 'running';
  const state = mr.state === 'opened' ? 'open' : mr.state === 'merged' ? 'merged' : 'closed';
  return { state, conflicts: mr.has_conflicts === true, ci, unanswered: unansweredIds(open) };
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
    if (ids && ids === seen) say(`threads ${ids}`);
    seen = ids;
    const green = now.ci === 'passed' || (now.ci === null && Date.now() - started >= NO_CI_MS);
    if (untilGreen && green && !ids) say('green');
  } catch (reason) {
    if (++errors >= MAX_ERRORS)
      say(`error ${reason instanceof Error ? reason.message.split('\n')[0] : reason}`);
  }
  await new Promise((resolve) => setTimeout(resolve, EVERY_MS));
}
