# Delivery workflows

## Add feature

Use for an OSS platform-core feature, a consumer work-order requiring `@openora/*` changes, or a standalone core feature.
Read-only until the plan is explicitly approved.

### Workflow

1. Resolve the input and collect scoped context from the ticket, relevant ADRs, generated contract surfaces, matching standards, source, and prior design discussion.
2. Run prompt enhancement before gathering deeply so the work remains scoped.
3. Grill every design choice that would change the build: scope, domain and seam ownership, data-model forks, regulatory and audit requirements, reuse, in-flight collisions, and config surface.
4. Present goal, acceptance criteria, locked decisions with sources, exact surface, boundary impact, risks, and a task breakdown mapped to roster agents.
5. Require explicit approval before editing.
6. Delegate implementation by slice: `expert` for requirements, `module-author` for a new module, `plugin-author` for an overlay, and `dev` for cross-module logic, contracts, services, or SDK work.
7. Ship co-located unit and integration tests with each slice.
8. Derive and run E2E cases from the acceptance criteria, including authz negatives, money/idempotency, and audit entries for mutations.
9. Send E2E and review findings back to the implementer until green.
10. Regenerate after contract or Drizzle changes, run the full verification gate, then invoke the pull-request workflow.

### Delivery rules

- Never write to Jira unless the user explicitly requests that exact write.
- Draft Slack notices only, and only after delivery.
- One PR per concern.
- Never push without explicit per-action confirmation.

## Create pull request

Use `gh` against `github.com/blurifycom/openora`.
Promotion follows `feature -> dev -> stage -> tag`.

### Target selection

- `dev` targets `stage`.
- `stage` is released by an explicitly requested tag, not a PR.
- `feat/*`, `fix/*`, and every other feature branch target `dev`.

### Workflow

1. Determine the current branch and target.
2. Inspect `git status -s` and stage only this work's files.
3. Leave foreign or pre-existing edits untouched and report them.
4. Create a lowercase conventional commit without AI trailers or sensitive data.
5. Run `pnpm verify`.
6. Report the commit SHA and stop for explicit per-action push confirmation.
7. Push only after that confirmation.
8. Reuse an existing matching PR if present; otherwise read `.github/pull_request_template.md`, complete its actual sections, then create the PR with `gh`.
9. Report the PR URL.

### Public-record rules

- Do not put internal URLs, secrets, tokens, customer or operator names, PII, internal hosts, or paths in commit messages, PR titles, or PR descriptions.
- Refer to tickets by bare key only.

## Fix pipeline

Use when CI is red, when the branch has conflicts with its target, or both. Input is a PR URL or number, an Actions run or job URL, or nothing (use the current branch).

### Read the failure before you edit

1. Resolve the run: `gh run list --branch <branch> --limit 5`, then `gh run view <id> --log-failed`. From a job URL, use `gh run view --job <job-id> --log-failed`.
2. Map the failed step to its local command and run that command locally. Never fix from a log alone.
   - `Verify` -> `pnpm verify`
   - `Commitlint` -> `pnpm commitlint --from origin/dev --to HEAD`
   - `Run migrations` -> `pnpm db:setup:test && pnpm exec turbo run build --filter=@openora/core && pnpm db:migrate`
   - `check:drift` inside `verify` -> `pnpm regen`, then commit the regenerated files
3. If the command passes locally but fails in CI, the difference is environment, not code: a missing migration, a seeded row the test assumed, ordering, or a stale lockfile. Say so instead of guessing at the source.

### Rebase and conflicts

1. `git fetch origin` then `git rebase origin/dev`. The target is `dev` for a feature branch and `stage` for `dev`.
2. Resolve each conflict from both sides' intent, not by taking one side wholesale. A conflict in a generated file is resolved by `pnpm regen`, never by hand.
3. Re-run the failing gate after the rebase; a rebase can surface a new failure.
4. Push with `--force-with-lease`, never plain `--force`, and only after the push confirmation below.

### Rules

- Fix the cause. Deleting a test, adding a skip, loosening a lint rule, or relaxing a gate to make CI green needs explicit approval first, and is reported as such.
- Never push without explicit per-action confirmation.
- After the push, watch the new run and report its result rather than assuming it passed.

## Fix review comments

Use on "fix the comments", "check <reviewer>'s comments", or a PR or discussion URL. Reviewers are human; a comment can be wrong.

### Workflow

1. Resolve the PR from `$ARGUMENTS` or from the current branch, and confirm the working tree is clean.
2. Fetch the threads: `gh api "repos/blurifycom/openora/pulls/<n>/comments" --paginate` for inline threads and `gh pr view <n> --json reviews,comments` for the rest. Keep the unresolved ones.
3. **Verify each comment against the code on this branch before fixing it.** Open the file, read the surrounding code, and decide: correct | already handled | wrong on this branch | out of scope for this PR. Report that verdict per comment and do not change code for a comment that is wrong.
4. Fix the ones that hold, smallest diff each, following the standard the comment cites.
5. Run `pnpm verify`.
6. Report the commit SHA and stop for explicit push confirmation.
7. Reply per thread after the push, so the reply points at real code. Write replies in the user's voice. State what changed and the SHA, or state plainly why the comment does not apply.
8. Report which comments were fixed, answered, and rejected.

### Rules

- Never silently skip a comment. Every thread gets a fix or a stated reason.
- Never resolve a thread you did not address.
- A comment that is right about core but belongs in a consumer overlay is answered, not fixed here.
