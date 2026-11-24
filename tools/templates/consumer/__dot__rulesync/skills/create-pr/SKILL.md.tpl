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

A review pack: a reviewer approves from it without reading code, and every claim in it is checkable. High level only: diagrams and plain words, no code, file paths, symbol, env or job names, no SQL - the diff tab has those. Generated over hand-written: diagrams from the diff, endpoints from the schema diff, traces from real spans; never invent numbers or traces.

`Closes <KEY>-n` (or `Refs <KEY>-n` when the PR does not finish the ticket, see `docs/agents/issue-tracker.md`) on the first line, then **How it was checked**: the pipeline result for the head SHA and the tests that cover the change. Then each section below only when its trigger fires - never an empty or "N/A" one - each collapsed in `<details><summary><b>N. Name</b>: its gist in one line</summary>`:

1. **Architecture diff** - a new module, service, package, external call or dependency between modules, or 3+ modules touched: mermaid of the changed nodes plus one unchanged neighbour each side, max ~10 nodes.
2. **Request path through infra** - env vars, IaC, routing, queues, cron, or an external caller (webhook, provider callback) on a risky path: numbered edges, who guards each hop, then what the code doesn't show.
3. **Business logic** - 3+ new branches or a changed error outcome: a decision flowchart, the exact status and reason per caller.
4. **Endpoints and permissions** - a route, schema, request/response type or status code changes: `flowchart LR` caller -> endpoint, payload on the edge, response and new status codes in the node, and whether it is backward compatible.
5. **Queries, indexes, trace** - new or changed queries on a request path, or data plus contract on a money path: one arrow per query with its index, the span waterfall when a local run exported a trace (local test data only), else "trace: none".
6. **Data** - a migration or schema change: erDiagram of new or changed tables, then locks, backfill, safety under traffic, env var names added or removed (never values).
7. **E2E steps** - a UI change, or an AC only an e2e proves: test -> web -> api -> DB, one block per step with request -> status and the DB delta.
8. **AC -> evidence** - the ticket has ACs: the `tester` verdict table `AC | behaviour | test | clip | trace | result @sha`, UNCHECKED rows included.
9. **Decisions to accept** - a product or tradeoff call the ticket did not settle; always on money, KYC, responsible-gambling or authz (then right under `Closes`): numbered, each with an owner.
10. **Test quality and rollout** - a large or risky change, or an env/config change: mutation rows, hostile cases, what is not covered; which config changes where, migration order, monitoring, what a revert leaves behind, what a person supplies before deploy ("Needs before deploy", names only), and every "Outside the repo" change.
11. **Video** - anything a player or operator sees: one walkthrough video (`ui-verify` "Video evidence"), a clip per acceptance criterion, the before/after pair on a fix, then the four shots of every changed screen, joined into one `<ticket>-walkthrough.mp4`, uploaded per `docs/agents/forge.md` ("Attach evidence") with its chapter list. Never a local path. An API-only change attaches the request/response trace instead.
12. **Code review guide** - a large change: ordered stops (contract -> tables -> server -> writes -> UI), each named by what it does.

Mermaid is horizontal by default, with no theme or fills: only a coloured border on what changed (added `#3fb950`, changed `#d29922`, removed `#f85149` dashed). No generic verification-command list: CI reports those checks.

A paired change links neither way: the shared branch name pairs the two requests. The OSS repo is public, so its PR never names this repo or the operator; this request may be read by people outside the team, so it never names or links the OSS repo.

## Rules

- NEVER push without an explicit per-action "yes push" from the user (or `/ship` on its ticket branch, see step 6). Invoking this skill does NOT authorize a push. Report the commit SHA, ask, then push only on yes.
- `pnpm verify` must pass on the commit you push.
- One ticket, one pull request, however big; never split a ticket into several by size. Unrelated changes found on the way stay out of it.
- No AI-attribution trailers anywhere - not in the commit, not in the pull-request title or description. No "Generated with", no "Co-Authored-By: Claude", no robot-emoji footer.
