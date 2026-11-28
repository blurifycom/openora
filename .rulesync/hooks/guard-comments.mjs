#!/usr/bin/env node
import { deny, extractCommand, readPayload } from './_shared.mjs';

const START = String.raw`^[\s(!{]*(?:[\w-]+\s*\(\)\s*[({]*\s*)?(?:(?:do|then|else|if|elif|while|until)\s+)?(?:(?:\w+=\S*|(?:command|env|exec|eval|nice|time|nohup|sudo|npx|pnpm\s+exec|xargs)(?:\s+-\S+)*|g?timeout(?:\s+-\S+)*\s+\S+)\s+["']?)*(?:\S*/)?`;
const COMMENT_CLI = new RegExp(
  START + String.raw`(?:gh\s+(?:pr|issue)\s+comment|glab\s+(?:mr|issue)\s+(?:note|comment))\b`,
);
const GH_PR_REVIEW = new RegExp(START + String.raw`gh\s+pr\s+review\b`);
const REVIEW_WITH_TEXT = /\s(?:-[cbrF]|--comment|--request-changes|--body|--body-file)/;
const API_CALL = new RegExp(START + String.raw`(?:gh|glab)\s+api\b`);
const COMMENT_PATH = /\/(?:comments|(?:draft_)?notes|reviews)(?=[/"'\s?]|$)/;
const REACTION_PATH =
  /\/(?:comments|notes)\/[^/\s"'?]+\/(?:reactions|award_emoji)(?:\/[^/\s"'?]*)?/g;
const DISCUSSIONS = /\/discussions\/?(?=["'\s?]|$)/;
const GRAPHQL = /\s["']?(?:\S*\/)?graphql(?=["'\s]|$)/;
const EXPLICIT_METHODS = /\s(?:-X\s*|--method[=\s]+)["']?([A-Za-z]+)/g;
const REPO_FLAG = /\s(?:-R\s*|--repo(?:=|\s+))\S+/g;
const FIELDS = /\s(?:-[fF]|--(?:raw-)?field\b|--input\b)/;
const COMMENT_MUTATION =
  /\b(?:addComment|addPullRequestReview\w*|submitPullRequestReview|updateIssueComment|updatePullRequestReview\w*|create(?:Diff|ImageDiff)?Note|createDiscussion|updateNote)\b/;
const OPAQUE_QUERY = /query=["']?(?:@|\$(?!\(cat\s*<<)|`)|--input\b/;
const SHELL_SCRIPT = /\b(?:ba|z|da)?sh\s+-\w*c\s+(["'])([\s\S]*?)\1/g;

const methodsOf = (call) => {
  const explicit = [...call.matchAll(EXPLICIT_METHODS)].map((match) => match[1].toUpperCase());
  return explicit.length > 0 ? explicit : [FIELDS.test(call) ? 'POST' : 'GET'];
};

const postsComment = (call) => {
  const withoutRepo = call.replace(REPO_FLAG, '');
  if (
    COMMENT_CLI.test(withoutRepo) ||
    (GH_PR_REVIEW.test(withoutRepo) && REVIEW_WITH_TEXT.test(withoutRepo))
  ) {
    return true;
  }
  if (!API_CALL.test(call)) {
    return false;
  }
  if (GRAPHQL.test(call)) {
    return COMMENT_MUTATION.test(command) || OPAQUE_QUERY.test(command);
  }
  const methods = methodsOf(call);
  const path = call.replace(REACTION_PATH, '');
  return (
    (methods.some((method) => ['POST', 'PUT', 'PATCH'].includes(method)) &&
      COMMENT_PATH.test(path)) ||
    (methods.includes('POST') && DISCUSSIONS.test(path))
  );
};

const command = extractCommand(readPayload())
  .replace(/\\\r?\n/g, ' ')
  .replace(SHELL_SCRIPT, '; $2 ;');
if (command.split(/\|\||\$\(|[;|&\n`]/).some(postsComment)) {
  deny(
    'Blocked: agent sessions never post on a pull/merge request (comment, reply, review, verdict note). Print the drafts as `file:line` + text for the user to post by hand. Resolving a thread your fix addressed is allowed.',
  );
}
process.exit(0);
