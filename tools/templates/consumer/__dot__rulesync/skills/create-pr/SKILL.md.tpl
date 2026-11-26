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

A review pack: a reviewer approves from it without reading code, and every claim in it is checkable. High level only: diagrams and plain words, no code, file paths, symbol or job names (env names only in slot 4), no SQL - the diff tab has those. Every number comes from a local run on seeded test data only, no ids, emails, amounts or hosts. Generated over hand-written: diagrams from the diff, endpoints from the schema diff, traces from real spans; never invent numbers or traces. A reviewer reads generated artifacts, not the diff.

`Closes <KEY>-n` (or `Refs <KEY>-n` when the PR does not finish the ticket, see `docs/agents/issue-tracker.md`) on the first line, one summary line, the generated "Touches:" line, then the same 14 slots in every PR, each open as a `##` heading in this order, `N/A: <reason>` in place when it does not apply: 1 Decisions made, 2 Origin (a fix) or Why (docs, deps, tests, tooling; at most three bullets), 3 How it was checked (the hostile cases tried, never green or a test count), 4 Env, 5 Consumer impact, 6 Related PRs, 7 Flow (Request path, Event flow, Pipeline), 8 Data model, 9 Migration, 10 Trace (one per changed endpoint, Queries and indexes), 11 Performance (Load, Measurement), 12 Evidence (Video table Flow | Before | Now | AC, Screenshots before | after, Sample output), 13 Business logic (and State machine), 14 Endpoints and permissions. Size changes nothing; no `<details>` folds; no tables outside slot 12. The repo's own pull-request template wins on slot names when it has one.

The `pr-description` skill, when installed, prints the skeleton from the diff with one fixed diagram shape per slot, so the same change draws the same diagram; an agent writes only the judgment lines. Without it, fill the slots by hand in the same shapes. What nobody measured stays visible: `not labelled`, `not measured`, `not traced`. Evidence is a table `Flow | Before | Now | AC`, one row per ticket AC, one clip per cell showing the whole flow of that AC in one take, from the screen the user starts on to the outcome the AC names (never a few seconds of the end state), the Before clip only on a fix; a look-only change shows Screenshots before | after instead. A fix fills Origin with `Found:`, `Lives in:`, `Cause:`, `Reproduced:`. Never "pipeline green" or a test count. On a money, KYC, responsible-gambling or authz change slots 1 and 3 are never N/A. Each decision there names its owner, and slot 3 adds "Not covered:" and "Revert leaves:"; "Dropped findings:" lists each review finding not fixed with why, security ones as a count only.

Mermaid is always horizontal (`flowchart LR`, an erDiagram or stateDiagram-v2 with `direction LR`; the request path stays one diagram however wide), with no theme or `style` lines: the only colour is a translucent fill and a border on what changed, `classDef added fill:#3fb95033,stroke:#3fb950,stroke-width:2px`, `classDef changed fill:#d2992233,stroke:#d29922,stroke-width:2px`, `classDef removed fill:#f8514933,stroke:#f85149,stroke-width:2px,stroke-dasharray:4`, with the template's legend line under it.

A paired change links neither way: the shared branch name pairs the two requests. The OSS repo is public, so its PR never names this repo or the operator; this request may be read by people outside the team, so it never names or links the OSS repo.

## Rules

- NEVER push without an explicit per-action "yes push" from the user (or `/ship` on its ticket branch, see step 6). Invoking this skill does NOT authorize a push. Report the commit SHA, ask, then push only on yes.
- `pnpm verify` must pass on the commit you push.
- One ticket, one pull request, however big; never split a ticket into several by size. Unrelated changes found on the way stay out of it.
- No AI-attribution trailers anywhere - not in the commit, not in the pull-request title or description. No "Generated with", no "Co-Authored-By: Claude", no robot-emoji footer.
