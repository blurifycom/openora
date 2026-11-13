#!/usr/bin/env node
// PreToolUse guard: agent sessions never post on a pull/merge request (review comments, thread
// replies, reviews, verdict notes). They draft the text and a person posts it. Resolving a thread
// stays allowed: `glab api -X PUT .../discussions/<id> -f resolved=true` and the GraphQL
// resolveReviewThread mutation. Fails open like every other guard: only a positive match denies.

import { deny, extractCommand, readPayload } from './_shared.mjs';

// A call starts its shell segment, after `(`, `{`, `!`, a loop or branch keyword, env assignments
// and wrappers (`env`, `sudo`, `eval "`, `xargs -n1`, ...), so a commit message that mentions
// `gh pr comment` is not one. An absolute path to the binary counts too.
const START = String.raw`^[\s(!{]*(?:(?:do|then|else)\s+)?(?:(?:\w+=\S*|(?:command|env|exec|eval|nice|time|nohup|sudo|npx|pnpm\s+exec|xargs)(?:\s+-\S+)*|g?timeout(?:\s+-\S+)*\s+\S+)\s+["']?)*(?:\S*/)?`;
const COMMENT_CLI = new RegExp(
  START + String.raw`(?:gh\s+(?:pr|issue)\s+comment|glab\s+(?:mr|issue)\s+(?:note|comment))\b`,
);
const GH_PR_REVIEW = new RegExp(START + String.raw`gh\s+pr\s+review\b`);
// `-b` and `-F` also match a value glued to the flag (`-bLGTM`).
const REVIEW_WITH_TEXT = /\s(?:-[cbrF]|--comment|--request-changes|--body|--body-file)/;
const API_CALL = new RegExp(START + String.raw`(?:gh|glab)\s+api\b`);
// `draft_notes` covers the draft and its `/publish` and `bulk_publish` calls.
const COMMENT_PATH = /\/(?:comments|(?:draft_)?notes|reviews)(?=[/"'\s?]|$)/;
const DISCUSSIONS = /\/discussions\/?(?=["'\s?]|$)/;
const GRAPHQL = /\sgraphql(?=["'\s]|$)/;
const EXPLICIT_METHOD = /\s(?:-X\s*|--method[=\s]+)["']?([A-Za-z]+)/;
// `gh api` and `glab api` default to POST once a field or body is passed.
const FIELDS = /\s(?:-f|-F|--field|--raw-field|--input)\b/;
const COMMENT_MUTATION =
  /\b(?:addComment|addPullRequestReview\w*|submitPullRequestReview|updateIssueComment|updatePullRequestReview\w*|create(?:Diff|ImageDiff)?Note|createDiscussion|updateNote)\b/;
// A query read from a file, stdin, a variable or a substitution cannot be inspected, so it counts
// as a mutation.
const OPAQUE_QUERY = /query=["']?(?:[@$`]|$)|--input\b/;
// `bash -c '<script>'` runs its script as calls of its own.
const SHELL_SCRIPT = /\b(?:ba|z|da)?sh\s+-\w*c\s+(["'])([\s\S]*?)\1/g;

const methodOf = (call) =>
  (call.match(EXPLICIT_METHOD)?.[1] ?? (FIELDS.test(call) ? 'POST' : 'GET')).toUpperCase();

const postsComment = (call) => {
  if (COMMENT_CLI.test(call) || (GH_PR_REVIEW.test(call) && REVIEW_WITH_TEXT.test(call))) {
    return true;
  }
  if (!API_CALL.test(call)) {
    return false;
  }
  if (GRAPHQL.test(call)) {
    // A query spans lines and variables, so the mutation is looked for in the whole command.
    return COMMENT_MUTATION.test(command) || OPAQUE_QUERY.test(call);
  }
  const method = methodOf(call);
  return (
    (['POST', 'PUT', 'PATCH'].includes(method) && COMMENT_PATH.test(call)) ||
    (method === 'POST' && DISCUSSIONS.test(call))
  );
};

// ponytail: splits on shell separators without parsing quotes; a body with `;` before the path slips
// through, a quoted `sh -c '...'` in a commit message is denied, and curl, `xargs -I {}` and a script
// piped into a shell are not seen
const command = extractCommand(readPayload())
  .replace(/\\\r?\n/g, ' ')
  .replace(SHELL_SCRIPT, '; $2 ;');
if (command.split(/\|\||\$\(|[;|&\n`]/).some(postsComment)) {
  deny(
    'Blocked: agent sessions never post on a pull/merge request (comment, reply, review, verdict note). Print the drafts as `file:line` + text for the user to post by hand. Resolving a thread your fix addressed is allowed.',
  );
}
process.exit(0);
