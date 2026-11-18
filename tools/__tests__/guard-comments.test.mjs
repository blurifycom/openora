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
  'git commit -m "x" 2>&1 | tail -1',
  'for i in 1 2; do gh pr view "$i"; done',
  'bash -c "gh pr view 5"',
  'gh api graphql -f query=\'\nmutation { resolveReviewThread(input: {threadId: "T"}) { thread { isResolved } } }\'',
  `gh api graphql -f query="$(cat <<'EOF'\nquery { viewer { login } }\nEOF\n)"`,
  'gh api repos/o/r/pulls/5/comments \\\n  --paginate',
  'gh pr --repo o/r view 5 --comments',
  `gh api /graphql -f query='query { viewer { login } }'`,
  'gh api -X GET repos/o/r/issues/5/comments',
  'gh api -X GET -X GET repos/o/r/issues/5/comments',
  'gh api repos/o/r/pulls/comments/9/reactions -f content=+1',
  'gh api -X POST repos/o/r/issues/comments/9/reactions -f content=eyes',
  'glab api -X POST "projects/1/merge_requests/2/notes/9/award_emoji" -f name=thumbsup',
  `gh api graphql -f query='mutation { addReaction(input: {subjectId: "C", content: EYES}) { reaction { id } } }'`,
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
  'if gh pr comment 5 -b x; then true; fi',
  'while true; do gh pr comment 5 -b x; done',
  'until gh pr comment 5 -b x; do true; done',
  'f(){ gh pr comment 5 -b x; }',
  'f() { glab mr note 2 -m x; }',
  'if true; then true; elif gh pr comment 5 -b x; then true; fi',
  'glab api -X POST "projects/1/merge_requests/2/notes" -f body=hi',
  'glab api "projects/1/merge_requests/2/discussions" -f body=hi',
  'glab api -X POST "projects/1/merge_requests/2/discussions/abc/notes" -f body=reply',
  'glab api -X PUT "projects/1/merge_requests/2/discussions/abc/notes/9" -f body=edit',
  `gh api graphql -f query='mutation { addPullRequestReviewThreadReply(input: {}) { comment { id } } }'`,
  `gh api graphql -f query='mutation { addComment(input: {subjectId: "P", body: "x"}) { clientMutationId } }'`,
  `glab api graphql -f query='mutation { createNote(input: {noteableId: "x", body: "y"}) { note { id } } }'`,
  'git push && glab mr note 2 -m "pushed"',
  'for id in 1 2; do glab mr note 2 -m "fixed $id"; done',
  'if true; then gh pr comment 5 -b x; fi',
  '{ gh pr comment 5 -b x; }',
  'env GH_TOKEN=t gh pr comment 5 -b x',
  'sudo -E glab mr note 2 -m x',
  '/opt/homebrew/bin/gh pr comment 5 -b x',
  'bash -c "glab mr note 2 -m x"',
  'git push & gh pr comment 5 -b x',
  'gh api repos/o/r/pulls/1/comments \\\n  -f body=x',
  'gh pr review 1 --approve -bLGTM',
  "gh api graphql -f query='\nmutation { addPullRequestReviewThreadReply(input: {}) { comment { id } } }'",
  'Q=x; gh api graphql -f query="$Q"',
  'gh api graphql -f query="$(cat m.graphql)"',
  'out=$(gh pr comment 1 -b x)',
  'echo `glab mr note 2 -m x`',
  'eval "gh pr comment 1 -b x"',
  'pnpm exec gh pr comment 1 -b x',
  'glab api -X POST "projects/1/merge_requests/2/discussions/" -f body=x',
  'glab api "projects/1/merge_requests/2/draft_notes" -f note=x',
  'glab api -X POST "projects/1/merge_requests/2/draft_notes/bulk_publish"',
  'glab api -X PUT "projects/1/merge_requests/2/draft_notes/3/publish"',
  `glab api graphql -f query='mutation { createDiscussion(input: {noteableId: "x", body: "y"}) { note { id } } }'`,
  'gh api -X POST graphql -f query=@mutation.graphql',
  `gh api --hostname github.com graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'`,
  'gh pr --repo o/r comment 5 -b x',
  'gh pr -R o/r comment 5 -b x',
  'gh pr -Ro/r comment 5 -b x',
  'gh pr --repo=o/r comment 5 -b x',
  'gh issue --repo o/r comment 5 -b x',
  'glab mr -R o/r note 2 -m x',
  'gh pr --repo o/r review 5 --comment -b nit',
  `gh api /graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'`,
  `gh api "/graphql" -f query='mutation { addComment(input: {}) { clientMutationId } }'`,
  `gh api https://api.github.com/graphql -f query='mutation { addComment(input: {}) { clientMutationId } }'`,
  'gh api repos/o/r/issues/5/comments -fbody=x',
  'gh api repos/o/r/pulls/5/comments -Fbody=x',
  'gh api repos/o/r/issues/5/comments --field body=x',
  'gh api repos/o/r/issues/5/comments --raw-field=body=x',
  'gh api -X GET -X POST repos/o/r/issues/5/comments -f body=x',
  'gh api --method GET --method=POST repos/o/r/issues/5/comments -f body=x',
  'gh api -X POST -X GET repos/o/r/issues/5/comments',
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
