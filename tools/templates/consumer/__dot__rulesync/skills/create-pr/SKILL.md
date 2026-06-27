---
name: create-pr
targets: ['claudecode']
description: Commit, push, and open a GitLab Merge Request following this repo's promotion chain (dev -> stage -> prod). Use on "create pr", "create mr", "open a pr/mr", "/create-pr", or "promote <branch>".
---

# create-pr

This repo is on **GitLab** (`<your-gitlab-project>`). "PR" = Merge Request. Use the `glab` CLI
(already installed). Environment branches are promoted along a fixed chain - never open an MR
straight to `prod` from a feature/dev branch.

## Promotion chain

| Source (current) branch            | MR target | Notes                                       |
| ---------------------------------- | --------- | ------------------------------------------- |
| `dev` (default working)            | `stage`   | Promote accumulated work to the staging env |
| `stage`                            | `prod`    | Promote staging -> production               |
| any `feat/*` / `fix/*` / `<KEY>-*` | `dev`     | Feature/ticket work merges into dev first   |

If the current branch isn't in the table, target `dev`.

## Steps

1. **Determine source + target.** `git branch --show-current` -> look it up in the
   table above to get the target.
2. **Scope the commit.** `git status -s`. Commit ONLY changes that belong to this
   unit of work. If unrelated/pre-existing edits are present, do NOT bundle them -
   stage your files explicitly and tell the user what you left out. Never
   `git add -A` blindly when foreign changes are in the tree.
3. **Commit.** Conventional-commit message (`feat:`, `fix:`, `docs:`, `refactor:`,
   `chore:`); for ticket work prefix the ticket key (e.g. `feat(<KEY>-123): ...`).
4. **Verify before pushing** (cheap insurance): run the repo's check (e.g.
   `pnpm typecheck && pnpm lint`). Don't push a red tree.
5. **Push** the current branch - but STOP and get an explicit per-action "yes push"
   from the user FIRST. Report the commit SHA, then ask. Invoking this skill is NOT
   push authorization. Pushing to a shared/env branch (`dev`, `stage`, `prod`)
   without that explicit yes is forbidden. Only after the yes: `git push -u origin <current>`.
6. **Open the MR** with glab (only after the push is confirmed + done):
   ```
   glab mr create --source-branch <current> --target-branch <target> \
     --title "<type>: <summary>" --description "<body>" --yes --remove-source-branch=false
   ```
   For a long-lived env branch (`dev`, `stage`, `prod`) NEVER pass
   `--remove-source-branch`. Reuse an existing open MR for the same source->target
   instead of creating a duplicate
   (`glab mr list --source-branch <current> --target-branch <target>`).
7. **Report** the MR URL back to the user.

## Rules

- NEVER push without an explicit per-action "yes push" from the user. Invoking this
  skill does NOT authorize a push. Report the commit SHA, ask, then push only on yes.
- The repo check must pass before the push.
- Keep the MR scoped to one concern; split unrelated changes into separate MRs.
