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
4. **Commit.** Conventional-commit message (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`); for ticket work prefix the ticket key (e.g. `feat({{trackerKey}}-123): ...`). No "Co-Authored-By" / "Generated with" trailers.
5. **Verify before pushing** (cheap insurance): run `/check` (typecheck + lint + unit). Don't push a red tree.
6. **Push** the current branch - but STOP and get an explicit per-action "yes push" from the user FIRST. Report the commit SHA, then ask. Invoking this skill is NOT push authorization. Pushing to a shared/env branch (`{{mrTarget}}`, `stage`, `prod`) without that explicit yes is forbidden. Only after the yes: `git push -u origin <current>`.
7. **Open the pull request** using the command in `docs/agents/forge.md` (only after the push is confirmed and done). Reuse an open request for the same source -> target instead of creating a duplicate, and never delete a long-lived branch on merge.
8. **Report** the pull-request URL back to the user, and the OSS PR URL when paired.

## Pull-request description

- State the user-facing change and its reason briefly.
- Add short, reproducible local test steps for the changed behavior (for example, `pnpm dev` then the relevant URLs or user flow).
- Do not include a generic verification-command list: CI already reports those checks.
- Include screenshots only when they materially show a UI change.
- A paired change links neither way: the shared branch name pairs the two requests. The OSS repo is public, so its PR never names this repo or the operator; this request may be read by people outside the team, so it never names or links the OSS repo.

## Rules

- NEVER push without an explicit per-action "yes push" from the user. Invoking this skill does NOT authorize a push. Report the commit SHA, ask, then push only on yes.
- The repo check must pass before the push.
- Keep the pull request scoped to one concern; split unrelated changes into separate ones.
