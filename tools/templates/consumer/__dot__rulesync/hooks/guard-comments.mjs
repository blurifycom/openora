#!/usr/bin/env node
// PreToolUse guard: agent sessions never post on a pull/merge request (review comments, thread
// replies, reviews, verdict notes). They draft the text and a person posts it. Resolving a thread
// stays allowed: `glab api -X PUT .../discussions/<id> -f resolved=true` and the GraphQL
// resolveReviewThread mutation. Fails open like every other guard: only a positive match denies.

import { deny, extractCommand, readPayload } from './_shared.mjs';

// A call starts its shell segment, after env assignments, `(`, `$(`, `command` or `xargs <flags>`,
// so a commit message that mentions `gh pr comment` is not one.
const START = String.raw`^[\s($]*(?:\w+=\S*\s+)*(?:(?:command|xargs(?:\s+-\S+)*)\s+)?`;
const COMMENT_CLI = new RegExp(
  START + String.raw`(?:gh\s+(?:pr|issue)\s+comment|glab\s+(?:mr|issue)\s+(?:note|comment))\b`,
);
const GH_PR_REVIEW = new RegExp(START + String.raw`gh\s+pr\s+review\b`);
const REVIEW_WITH_TEXT = /\s(?:-c|--comment|-r|--request-changes|-b|--body|-F|--body-file)\b/;
const API_CALL = new RegExp(START + String.raw`(?:gh|glab)\s+api\b`);
const COMMENT_PATH = /\/(?:comments|notes|reviews)(?=[/"'\s?]|$)/;
const DISCUSSIONS = /\/discussions(?=["'\s?]|$)/;
const EXPLICIT_METHOD = /\s(?:-X\s*|--method[=\s]+)["']?([A-Za-z]+)/;
// `gh api` and `glab api` default to POST once a field or body is passed.
const FIELDS = /\s(?:-f|-F|--field|--raw-field|--input)\b/;
const COMMENT_MUTATION =
  /\b(?:addComment|addPullRequestReview\w*|submitPullRequestReview|updateIssueComment|updatePullRequestReview\w*|create(?:Diff|ImageDiff)?Note|updateNote)\b/;

const methodOf = (call) =>
  (call.match(EXPLICIT_METHOD)?.[1] ?? (FIELDS.test(call) ? 'POST' : 'GET')).toUpperCase();

const postsComment = (call) => {
  if (COMMENT_CLI.test(call) || (GH_PR_REVIEW.test(call) && REVIEW_WITH_TEXT.test(call))) {
    return true;
  }
  if (!API_CALL.test(call)) {
    return false;
  }
  if (/\bapi\s+graphql\b/.test(call)) {
    return COMMENT_MUTATION.test(call);
  }
  const method = methodOf(call);
  return (
    (['POST', 'PUT', 'PATCH'].includes(method) && COMMENT_PATH.test(call)) ||
    (method === 'POST' && DISCUSSIONS.test(call))
  );
};

// ponytail: splits on shell separators without parsing quotes; a body with `;` before the path slips through
const calls = extractCommand(readPayload()).split(/&&|\|\||[;|\n]/);
if (calls.some(postsComment)) {
  deny(
    'Blocked: agent sessions never post on a pull/merge request (comment, reply, review, verdict note). Print the drafts as `file:line` + text for the user to post by hand. Resolving a thread your fix addressed is allowed.',
  );
}
process.exit(0);
