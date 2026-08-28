---
name: create-pr
targets: ['*']
description: Commit, push, and open a GitLab Merge Request following this repo's promotion chain ({{mrTarget}} -> stage -> prod). Use on "create pr", "create mr", "open a pr/mr", "/create-pr", or "promote <branch>".
---

# create-pr ({{name}})

This repo is on **GitLab** (`{{gitRemotePath}}`). "PR" = Merge Request. Use the `glab` CLI (already installed). Environment branches are promoted along a fixed chain - never open an MR straight to `prod` from a feature branch.

## Promotion chain

- Topic branch (`feat/*`, `fix/*`, `{{trackerKey}}-*`) -> `{{mrTarget}}`: feature/ticket work merges into `{{mrTarget}}` first.
- `{{mrTarget}}` (default working) -> `stage`: promote accumulated work to the staging env.
- `stage` -> `prod`: promote staging -> production.

If the current branch isn't in the list, target `{{mrTarget}}`.

## Steps

1. **Determine source + target.** `git branch --show-current` -> look it up in the table above to get the target.
2. **Scope the commit.** `git status -s`. Commit ONLY changes that belong to this unit of work. If unrelated/pre-existing edits are present, do NOT bundle them - stage your files explicitly and tell the user what you left out. Never `git add -A` blindly when foreign changes are in the tree.
3. **Commit.** Conventional-commit message (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`); for ticket work prefix the ticket key (e.g. `feat({{trackerKey}}-123): ...`). No "Co-Authored-By" / "Generated with" trailers.
4. **Verify before pushing** (cheap insurance): run `/check` (typecheck + lint + unit). Don't push a red tree.
5. **Push** the current branch - but STOP and get an explicit per-action "yes push" from the user FIRST. Report the commit SHA, then ask. Invoking this skill is NOT push authorization. Pushing to a shared/env branch (`{{mrTarget}}`, `stage`, `prod`) without that explicit yes is forbidden. Only after the yes: `git push -u origin <current>`.
6. **Open the MR** with glab (only after the push is confirmed + done):
   ```
   glab mr create --source-branch <current> --target-branch <target> \
     --title "<type>: <summary>" --description "<body>" --yes --remove-source-branch=false
   ```
   For a long-lived env branch (`{{mrTarget}}`, `stage`, `prod`) NEVER pass `--remove-source-branch`. Reuse an existing open MR for the same source->target instead of creating a duplicate (`glab mr list --source-branch <current> --target-branch <target>`).
7. **Report** the MR URL back to the user.

## MR description

- State the user-facing change and its reason briefly.
- Add short, reproducible local test steps for the changed behavior (for example, `pnpm dev` then the relevant URLs or user flow).
- Do not include a generic verification-command list: CI already reports those checks.
- Include screenshots only when they materially show a UI change.

## Rules

- NEVER push without an explicit per-action "yes push" from the user. Invoking this skill does NOT authorize a push. Report the commit SHA, ask, then push only on yes.
- The repo check must pass before the push.
- Keep the MR scoped to one concern; split unrelated changes into separate MRs.
