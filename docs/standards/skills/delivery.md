# Delivery workflows

## Ship

Use for an OSS platform-core feature, a consumer work-order requiring `@openora/*` changes, or a standalone core feature. Input is a ticket key, a work-order path, or a described feature. One change in, a green reviewed PR out, with nobody in the loop.

You run in the main session and are the only one who delegates: each step goes to its subagent, you read its verdict and pick the next step yourself. Every subagent you start is told it starts no subagents of its own. A domain question one returns comes back to you; ask `expert` and pass the answer on.

`--ask` stops for approval after the plan and before the push. Without it, invoking `/ship` authorizes the writes listed under the rules below, and only those.

### Read the state, do the next step

Every run starts here, so a run that died midway resumes where it stopped: the ticket or work order, `git branch -a --list '*<key>*'`, then `gh pr list --head <branch>` and its checks.

- No plan yet -> 1. A branch, no PR -> 3, 4, 5 (a dead run's verdicts are gone, so test and review run again). An open PR with red checks or conflicts -> the fix-pipeline workflow. Unanswered review threads -> the fix-review-comments workflow. Green with nothing unanswered, or merged -> report it and stop.

### Workflow

1. **Plan.** Start `planner` with the input. `Asked:` -> report the questions (and post them on the ticket, see rules), stop. Otherwise keep its plan and test cases for every later step.
2. **Build.** Add a worktree for the branch off freshly fetched `dev`. Start the implementer by slice: `module-author` for a new module, `plugin-author` for an overlay, `builder` for cross-module logic, contracts, services, or SDK work. `Blocked:` -> report it, stop. Check each reply holds `pnpm verify` output from HEAD and `git status` is clean; missing either goes back once, then counts as blocked.
3. **Test.** Start `tester` in the worktree with the plan's test cases. Any FAIL row goes back to the implementer with those rows only, then `tester` again. A failing test called pre-existing without its run on the base commit goes back to `tester` once to run it there; still unrun, it is a FAIL.
4. **Review.** Start `security-reviewer` (focus `risk`, which also works `contract-reviewer`'s checklist) and `quality-reviewer` in parallel on the branch diff per `review.md`, with the tester's verdict table. Every finding with a fix gets fixed, whatever its severity, once it holds: dedupe across reviewers, open each `file:line` and confirm the evidence on this branch; one that doesn't hold is dropped into the PR description with why. Send the rest to the implementer in one go, then 3 for the cases they touch and 4 again; a later round of 4 reviews only the new commits and whether each sent finding is fixed. Rounds of 3 and 4 share one budget of three; after the third with anything still failing, report what is left and stop.
5. **Finish.** `docs` on the branch diff per `docs/standards/documentation.md`, `cleaner` over it, regenerate after contract or Drizzle changes, `pnpm verify`, then the pull-request workflow below.

### Delivery rules

- Tracker writes, only under `/ship` and only on its own ticket, through the tracker `docs/agents/issue-tracker.md` points to: the plan and questions comments, a blocker comment, the PR link, and the transitions to in progress and in review. Nothing else, and never ticket content in this public repo.
- Push the branch and open its PR without asking under `/ship` (not under `--ask`). Never push `dev` or `stage`, never force-push.
- Draft Slack notices only, and only after delivery.
- One PR per concern.
- The orchestrator edits no code, commits nothing and runs no gate itself: every fix goes to the implementer. Code changed after 3 means 3 runs again for the cases it touches, and 4 for the new commits.

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
4. Pre-flight, before the commit so both land in it rather than a follow-up: run `cleaner` over the diff, and run `docs` scoped to the diff if the change touched a module surface, an adapter contract, a config field, a standard, or an "is" claim in an ADR.
5. Create a lowercase conventional commit without AI trailers or sensitive data.
6. Run `pnpm verify`.
7. Report the commit SHA and stop for explicit per-action push confirmation. Under `/ship` without `--ask`, the invocation is that confirmation for its branch.
8. Push only after that confirmation.
9. Reuse an existing matching PR if present; otherwise read `.github/pull_request_template.md`, complete its actual sections, then create the PR with `gh`.
10. Report the PR URL.

### Public-record rules

- Do not put internal URLs, secrets, tokens, customer or operator names, PII, internal hosts, or paths in commit messages, PR titles, or PR descriptions.
- Refer to tickets by bare key only.
- A PR paired with a downstream consumer change uses the consumer's branch name, which is what pairs them. Neither request links to the other, and this PR never names the consumer, because this repo is public.

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
4. Push with `--force-with-lease`, never plain `--force`, and only after the push confirmation below. Under `/ship` a rebased branch is reported, not force-pushed: that one push always waits for a yes.

### Rules

- Fix the cause. Deleting a test, adding a skip, loosening a lint rule, or relaxing a gate to make CI green needs explicit approval first, and is reported as such.
- Never push without explicit per-action confirmation. Under `/ship` without `--ask`, the invocation is that confirmation for a plain push of its branch.
- After the push, watch the new run and report its result rather than assuming it passed.

## Fix review comments

Use on "fix the comments", "check <reviewer>'s comments", or a PR or discussion URL. Reviewers are human; a comment can be wrong.

### Workflow

1. Resolve the PR from `$ARGUMENTS` or from the current branch, and confirm the working tree is clean.
2. Fetch the threads: `gh api "repos/blurifycom/openora/pulls/<n>/comments" --paginate` for inline threads and `gh pr view <n> --json reviews,comments` for the rest. Keep the unresolved ones.
3. **Verify each comment against the code on this branch before fixing it.** Open the file, read the surrounding code, and decide: correct | already handled | wrong on this branch | out of scope for this PR. Report that verdict per comment and do not change code for a comment that is wrong.
4. Fix the ones that hold, smallest diff each, following the standard the comment cites.
5. Prove the fixed flow end to end - request to database and back - before calling it fixed. Drive the real route (`call(router.x.y, input, { context })` or `bootTestApp`) against a real DB, then assert on the rows the request actually wrote and on the response read back off them. A service method called directly does not prove the route, the transaction boundary, or the audit row; leave the end-to-end assertion behind as a test.
6. Run `pnpm verify`.
7. Report the commit SHA and stop for explicit push confirmation (under `/ship` without `--ask`, push its branch).
8. Reply per thread after the push, so the reply points at real code. Write replies in the user's voice. State what changed and the SHA, or state plainly why the comment does not apply.
9. Report which comments were fixed, answered, and rejected.

### Rules

- Never silently skip a comment. Every thread gets a fix or a stated reason.
- Never resolve a thread you did not address.
- A comment that is right about core but belongs in a consumer overlay is answered, not fixed here.
- Never report a money, audit, or authz comment as fixed on the strength of a green unit test alone - the end-to-end run is what proves it.
