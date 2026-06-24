---
name: create-pr
targets: ['claudecode']
description: Commit, push, and open a GitLab Merge Request following this repo's promotion chain (dev -> stage -> main/tag). Use on "create pr", "create mr", "open a pr/mr", "/create-pr", or "promote <branch>".
---

# create-pr (oss)

This repo is on **GitLab** (`git.example.com:consumer/oss`). "PR" = Merge
Request. Use the `glab` CLI (already installed). Environment branches are promoted
along a fixed chain - never open an MR straight to `main` from a feature/dev branch.

## Promotion chain

| Source (current) branch | MR target | Notes                                          |
| ----------------------- | --------- | ---------------------------------------------- |
| `dev` (default working) | `stage`   | Promote accumulated work to the staging env    |
| `stage`                 | `main`    | Release candidate -> main                      |
| `main`                  | (git tag) | Cut a release tag, no MR (see "Release" below) |
| any `feat/*` / `fix/*`  | `dev`     | Feature work merges into dev first             |

If the current branch isn't in the table, target `dev`.

## Steps

1. **Determine source + target.** `git branch --show-current` -> look it up in the
   table above to get the target.
2. **Scope the commit.** `git status -s`. Commit ONLY changes that belong to this
   unit of work. If unrelated/pre-existing edits are present (someone else's WIP, an
   unrelated migration, a half-finished module), do NOT bundle them - stage your
   files explicitly and tell the user what you left out. Never `git add -A` blindly
   when foreign changes are in the tree.
3. **Commit.** Conventional-commit message (`feat:`, `fix:`, `docs:`, `refactor:`,
   `chore:`). End the body with the Co-Authored-By trailer the global rules require.
   Keep the message free of sensitive/internal data (see "No sensitive data" below).
4. **Verify before pushing** (cheap insurance): `pnpm verify`. Don't push a red tree.
5. **Push** the current branch - but STOP and get an explicit per-action "yes push"
   from the user FIRST. Report the commit SHA, then ask. Invoking this skill is NOT
   push authorization. Pushing to a shared/env branch (`dev`, `stage`, `main`)
   without that explicit yes is forbidden. Only after the yes: `git push -u origin <current>`.
6. **Open the MR** with glab (only after the push is confirmed + done):
   ```
   glab mr create --source-branch <current> --target-branch <target> \
     --title "<type>: <summary>" --description "<body>" --yes --remove-source-branch=false
   ```
   For a long-lived env branch (`dev`, `stage`) NEVER pass `--remove-source-branch`.
   Reuse an existing open MR for the same source->target instead of creating a duplicate
   (`glab mr list --source-branch <current> --target-branch <target>`).
7. **Report** the MR URL back to the user.

## Release (oss: the `-> tag` step)

oss has no `prod` branch; production is a git tag cut from `main`:
`git tag vX.Y.Z && git push origin vX.Y.Z`. Only do this when the user explicitly
asks to cut a release, and confirm the version first.

## No sensitive data in titles / descriptions / commits

The MR title, description, and commit messages are the PUBLIC-facing record. Never
put internal or sensitive data in them:

- NO internal URLs - Jira/Confluence/Slack/Notion/Google Docs links, dashboards,
  CI/CD links, or any `*.atlassian.net`, internal git host, or company-internal
  hostname. Reference a ticket by its bare key only (e.g. `ABC-45`), never the URL.
- NO secrets, tokens, credentials, customer/operator names, PII, or internal IPs.
- NO internal-only paths, server names, or environment identifiers.

Describe the change in terms of WHAT and WHY plus the ticket key. If a reviewer
needs the ticket, the key is enough - the tracker is one search away. When in doubt,
leave it out.

## Rules

- NEVER push without an explicit per-action "yes push" from the user. Invoking this
  skill does NOT authorize a push. Report the commit SHA, ask, then push only on yes.
- `pnpm verify` must pass before the push.
- Keep the MR scoped to one concern; split unrelated changes into separate MRs.
- Keep titles/descriptions/commits free of sensitive/internal data (see above).
