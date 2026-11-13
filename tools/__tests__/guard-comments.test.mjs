// The guard-comments hook keeps agent sessions from posting on a pull/merge request while still
// letting them read threads and resolve the ones they fixed. Runs the repo copy and the consumer
// template copy against the same allow and deny cases.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const GUARDS = [
  '../../.rulesync/hooks/guard-comments.mjs',
  '../templates/consumer/__dot__rulesync/hooks/guard-comments.mjs',
].map((path) => fileURLToPath(new URL(path, import.meta.url)));
const DENIED = 2;
const ALLOWED = 0;

const ALLOW = [
  'gh pr view 5 --comments',
  'gh api --paginate "repos/o/r/pulls/5/comments"',
  'gh api repos/o/r/issues/5/comments --method GET -f per_page=100',
  'glab api --paginate "projects/1/merge_requests/2/discussions?per_page=100"',
  'glab api -X PUT "projects/1/merge_requests/2/discussions/abc123" -f resolved=true',
  `gh api graphql -f query='mutation { resolveReviewThread(input: {threadId: "T"}) { thread { isResolved } } }'`,
  `gh api graphql -f query='query { repository(owner: "o", name: "r") { pullRequest(number: 5) { reviewThreads(first: 100) { nodes { comments(last: 1) { nodes { id } } } } } } }'`,
  'gh pr review 5 --approve',
  'gh api -X DELETE repos/o/r/pulls/comments/9',
  'git commit -m "docs: never post on the PR, gh pr comment is blocked"',
  'glab mr view 2',
];

const DENY = [
  'glab mr note 2 -m "Agent: fixed"',
  'glab mr comment 2 -m "done"',
  'gh pr comment 5 --body "looks good"',
  'gh issue comment 5 --body "fixed"',
  'gh pr review 5 --comment -b "nit"',
  'gh pr review 5 --request-changes --body "fix this"',
  'gh pr review 5 --approve --body "LGTM"',
  'gh api "repos/o/r/pulls/5/comments" -f body=x -f commit_id=s -f path=a.ts -F line=3 -f side=RIGHT',
  'gh api repos/o/r/pulls/5/comments/9/replies -f body=ok',
  'gh api -X PATCH repos/o/r/pulls/comments/9 -f body=edited',
  'gh api repos/o/r/issues/5/comments -f body=verdict',
  'gh api --method POST repos/o/r/pulls/5/reviews -f event=COMMENT',
  'gh api -X POST repos/o/r/pulls/5/reviews/7/events -f event=APPROVE',
  'glab api -X POST "projects/1/merge_requests/2/notes" -f body=hi',
  'glab api "projects/1/merge_requests/2/discussions" -f body=hi',
  'glab api -X POST "projects/1/merge_requests/2/discussions/abc/notes" -f body=reply',
  'glab api -X PUT "projects/1/merge_requests/2/discussions/abc/notes/9" -f body=edit',
  `gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {}) { comment { id } } }'`,
  `gh api graphql -f query='mutation { addComment(input: {subjectId: "P", body: "x"}) { clientMutationId } }'`,
  `glab api graphql -f query='mutation { createNote(input: {noteableId: "x", body: "y"}) { note { id } } }'`,
  'git push && glab mr note 2 -m "pushed"',
];

const exitCode = (guard, command) =>
  spawnSync('node', [guard], { input: JSON.stringify({ tool_input: { command } }) }).status;

for (const guard of GUARDS) {
  test(`${guard}: reads and resolves are allowed`, () => {
    for (const command of ALLOW) {
      assert.equal(exitCode(guard, command), ALLOWED, command);
    }
  });
  test(`${guard}: posting a comment, reply, or review is denied`, () => {
    for (const command of DENY) {
      assert.equal(exitCode(guard, command), DENIED, command);
    }
  });
}
