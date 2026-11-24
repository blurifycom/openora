---
name: create-pr
targets: ['*']
description: Commit, push, and open a pull request on this repo's forge, targeting the branch `docs/agents/forge.md` names. Use on "create pr", "create mr", "open a pr/mr", "/create-pr", or "promote <branch>".
---

# create-pr ({{name}})

`docs/agents/forge.md` is the source of truth for this repo's forge: which CLI to use, how to open and read a pull request, and where a change lands. Read it first - the steps below never hardcode a forge command.

## Steps

1. **Determine source + target.** `git branch --show-current`, then take the target from the "Where a change lands" section of `docs/agents/forge.md`.
2. **Land the paired OSS change first, if there is one.** It is paired when `{{ossDir}}/.worktrees/<branch, / as +>` exists or `git -C {{ossDir}} branch --list <branch>` matches. First finish step 3 of "Changing OSS core" in the `oss-boundaries` rule (verify, OSS review, no open BLOCK). Then run steps 3-7 inside that worktree under the OSS repo's own delivery rules (`<worktree>/docs/standards/skills/delivery.md`: `gh`, its PR template, `pnpm verify`, public-record rules), with its own explicit push confirmation. Reuse an open OSS PR (`gh pr list --head <branch>` in the worktree).
3. **Scope the commit.** `git status -s`. Commit ONLY changes that belong to this unit of work. If unrelated/pre-existing edits are present, do NOT bundle them - stage your files explicitly and tell the user what you left out. Never `git add -A` blindly when foreign changes are in the tree.
4. **Commit.** Conventional-commit message (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`); the scope is a commitlint-enum package or app, never the ticket key; for ticket work the key goes at the END of the subject (e.g. `feat(web): add deposit limits ({{trackerKey}}-123)`). No "Co-Authored-By" / "Generated with" trailers.
5. **Verify the commit.** Run `pnpm verify` on the committed, clean tree: it is the pre-MR gate and records the verified commit. The `guard-mr` hook refuses to open the pull request until that record matches HEAD. Don't push a red tree.
6. **Push** the current branch - but STOP and get an explicit per-action "yes push" from the user FIRST. The one exception: run by `ship` without `--ask`, the `/ship` invocation is that yes for its ticket branch only. Report the commit SHA, then ask. Invoking this skill is NOT push authorization. Pushing to a shared/env branch (`{{mrTarget}}`, `stage`, `prod`) without that explicit yes is forbidden. Only after the yes: `git push -u origin <current>`.
7. **Open the pull request as a draft** using the command in `docs/agents/forge.md` (only after the push is confirmed and done). Run by `ship`: stop here, its step 7 marks the request ready. Otherwise start `node .rulesync/skills/babysit/babysit.mjs <branch> --until-green` as a background command, never a sleep loop; at `green` mark the request ready for review (`docs/agents/forge.md`). Red stays a draft: fix it first. Reuse an open request for the same source -> target instead of creating a duplicate, and never delete a long-lived branch on merge.
8. **Report** the pull-request URL back to the user, and the OSS PR URL when paired.

## Pull-request description

A review pack: what a reviewer needs to retell the change after one read. Generated, not written from memory: diffs come from `git diff origin/<target>...HEAD`, schema from the migration files, evidence from the test run, and every hand-written claim links `file#Lnn` at the head SHA. Summary, risks and diagram sit at the top; every other section fits one screen, with longer detail in `<details>`. A section the change has nothing for is left out. In this order:

1. **Summary** - one sentence: the user-facing change and why.
2. **Risks** - numbered, worst first, each backed by a number or a code link. "None." when there are none.
3. **Diagram** - a change that adds or changes a flow across components (a request path through gates and a vendor, a state machine, an async job or webhook, a new module or overlay) embeds a fenced `mermaid` block (`flowchart` or `sequenceDiagram`): nodes named as the code names them, under ~15, refusal and failure branches included. No flow (copy, styling, deps, a one-file fix): no diagram.
4. **API** - a table `endpoint | runs in | change (added, changed, removed) | code link`, one row per endpoint, event or job. A ```diff of the payload only when its shape changes.
5. **DB and config** - one ```diff block: tables and columns the migrations add or change, data backfilled or copied, env vars added or removed. A value only a person has goes under "Needs before deploy".
6. **Traces** - for a changed request path on money or a hot path, when the local run exported traces: the span waterfall of one run per main path (queries, writes and locks in `<details>`), one sentence per failure path with its status and reason per caller. n = 1, so no percentiles.
7. **AC and evidence** - the `tester` verdict table: `AC | evidence (spec:test, trace id, video chapter) | not tested`, UNCHECKED rows included.
8. **Video** - one walkthrough video (`ui-verify` "Video evidence"): a clip per acceptance criterion, the before/after pair on a fix, then the four shots of every changed screen, joined into one `<ticket>-walkthrough.mp4`. Upload that one file to the forge and embed the markdown it returns with its chapter list - `docs/agents/forge.md` says how (its "Attach evidence" section). A local path under `apps/e2e/test-results/` shows a reviewer nothing; never put one in a description. An API-only change attaches the request/response trace instead. Skip it only when nothing user-visible changed.
9. **Test locally** - short, reproducible steps for the changed behaviour (`pnpm dev`, then the URLs or the flow).
10. **After merge** - docs, runbooks or ADRs to update and rollout steps. "Outside the repo" changes go here too.

Then close the ticket by key: `Closes <KEY>-n` if this PR finishes it, else `Refs <KEY>-n` (see `docs/agents/issue-tracker.md`). No generic verification-command list: CI reports those checks.

A paired change links neither way: the shared branch name pairs the two requests. The OSS repo is public, so its PR never names this repo or the operator; this request may be read by people outside the team, so it never names or links the OSS repo.

## Rules

- NEVER push without an explicit per-action "yes push" from the user (or `/ship` on its ticket branch, see step 6). Invoking this skill does NOT authorize a push. Report the commit SHA, ask, then push only on yes.
- `pnpm verify` must pass on the commit you push.
- One ticket, one pull request, however big; never split a ticket into several by size. Unrelated changes found on the way stay out of it.
- No AI-attribution trailers anywhere - not in the commit, not in the pull-request title or description. No "Generated with", no "Co-Authored-By: Claude", no robot-emoji footer.
