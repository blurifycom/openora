---
name: create-pr
description: Commit, push, and open a GitHub Pull Request following this repo's promotion chain (dev -> stage -> tag). Use on "create pr", "open a pr", "/create-pr", or "promote <branch>".
---

# create-pr (oss)

This repo is on **GitHub** (`github.com/blurifycom/oss`). Use the `gh` CLI. Branches are promoted along a fixed chain - never open a PR straight to `stage` from a feature branch.

## Promotion chain

| Source (current) branch | PR target | Notes                                  |
| ----------------------- | --------- | -------------------------------------- |
| `dev` (default working) | `stage`   | Promote accumulated work to staging    |
| `stage`                 | (git tag) | Cut a release tag, no PR (see Release) |
| any `feat/*` / `fix/*`  | `dev`     | Feature work merges into dev first     |

Any other branch: target `dev`.

## Steps

1. **Determine source + target.** `git branch --show-current` -> the table above.
2. **Scope the commit.** `git status -s`. Commit ONLY changes belonging to this unit of work. Foreign/pre-existing edits in the tree: stage your files explicitly, tell the user what you left out. Never `git add -A` blindly.
3. **Commit.** Conventional-commit message with a valid scope (see `conventions` section 12). No AI attribution trailers. Keep the message free of sensitive/internal data (below).
4. **Verify before pushing:** `pnpm verify`. Don't push a red tree.
5. **Push - STOP first.** Report the commit SHA, then ask for an explicit per-action "yes push". Invoking this skill is NOT push authorization; shared branches (`dev`, `stage`) especially. Only after the yes: `git push -u origin <current>`.
6. **Open the PR** (after the confirmed push):
   ```
   gh pr create --base <target> --head <current> --title "<type>(<scope>): <summary>" --body "<what / why / AC / ticket key>"
   ```
   Reuse an existing open PR for the same head->base instead of duplicating (`gh pr list --head <current> --base <target>`).
7. **Report** the PR URL.

## Release (the `-> tag` step)

Production is a git tag cut from `stage`: `git tag vX.Y.Z && git push origin vX.Y.Z`. Only on an explicit user request; confirm the version first.

## No sensitive data in titles / descriptions / commits

They are the public-facing record. Never include: internal URLs (Jira/Confluence/Slack/Notion, dashboards, CI links - reference a ticket by bare key, eg `ABC-45`), secrets, tokens, customer/operator names, PII, internal IPs/hostnames/paths. When in doubt, leave it out.

## Rules

- NEVER push without an explicit per-action "yes push". Report SHA, ask, push only on yes.
- `pnpm verify` must pass before the push.
- One PR = one concern; split unrelated changes.
