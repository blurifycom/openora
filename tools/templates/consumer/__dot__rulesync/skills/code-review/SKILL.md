---
name: code-review
description: Multi-agent code review of the working branch against this repo's conventions, OSS-core boundaries, security, and operator-domain fit. Fans out a configurable number of parallel reviewers, each grounded in the rule docs, then synthesizes one verdict. Use on "review this", "code review", "/code-review", optionally "--agents N", "--base <ref>", "--fix", a GitLab MR number, or paths.
---

# code-review

Orchestrate a parallel, convention-grounded code review of the current change set in this downstream
igaming operator repo. You are the orchestrator: scope the diff, fan out N reviewers across review
dimensions, dedup their findings, and report ONE verdict. Report-only by default - never edit unless
`--fix` is passed.

Copy this checklist and tick it off as you go:

```
code-review:
- [ ] 1. Parse args (--agents / --base / MR# / paths / --fix)
- [ ] 2. Scope the diff; if empty, ask
- [ ] 3. Pick applicable dimensions (only those with touched files)
- [ ] 4. Spawn reviewers in ONE message (parallel)
- [ ] 5. Dedup + apply the evidence/confidence gate
- [ ] 6. Report one verdict (+ apply fixes only if --fix)
```

## 1. Parse `$ARGUMENTS`

| Token               | Meaning                                                         | Default                         |
| ------------------- | --------------------------------------------------------------- | ------------------------------- |
| `--agents N`        | how many parallel reviewers to spawn (1-5)                      | one per applicable dimension    |
| `--base <ref>`      | branch to diff against                                          | `dev` (this repo's integration) |
| `<number>` (e.g. 8) | a GitLab MR number - review that MR's diff (`glab mr diff <n>`) | -                               |
| paths               | restrict review to these files/dirs                             | whole diff                      |
| `--fix`             | apply fixes for `[BLOCK]`/`[WARN]` findings after the review    | off (report only)               |

## 2. Scope the diff (do this first)

- Branch: `git diff <base>...HEAD --name-only` (default base `dev`). If empty, fall back to
  unstaged/staged via `git status -s`; if still empty, ask what to review.
- MR number given: `glab mr diff <n>` for the patch + `glab mr view <n>` for intent.
- Group changed files by app/package so reviewers and any file-split share the same map.

## 3. Ground every reviewer (mandatory)

Each spawned reviewer MUST read the actual changed code AND the rule docs that own its dimension
before judging - do not infer behavior from a diff hunk. If a finding depends on what a called
function does, open it; if you can't cite it, fetch it. These docs are the single source of truth -
cite them in findings:

- `.claude/rules/overview.md` - what this repo is (a downstream operator on `@openora/*` consumed as linked packages), the HARD RULE that OSS core is read-only, how you work here, and the enforced import/module boundaries (extend only from the outside).
- `.claude/rules/db-conventions.md` - SQL / Drizzle rules for tables an overlay owns.
- Any other `.claude/rules/*.md` the consumer has added (e.g. `conventions`, `oss-boundaries`, `frontend`) - cite whichever own the touched files.

## 4. Review dimensions

Each dimension maps to a rule doc and, where one fits, a pre-scoped subagent. Spawn only the
dimensions whose files actually changed.

| #   | Dimension                  | Covers                                                                                                                              | Use subagent       |
| --- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| 1   | OSS boundaries & extension | never edits `@openora/*` core; extends only via `extensions.config.ts` / overlay plugins / vendor adapters; no deep `dist/` imports | general (overview) |
| 2   | Conventions & quality      | naming, functional/immutable, no `any`/`interface`/default-export, types inferred not hand-written, comments WHY, tests             | general (overview) |
| 3   | Frontend                   | React/styling rules - only if a frontend app or shared UI package was added and changed                                             | general (frontend) |
| 4   | Security & secrets         | authz on overlay routes, vendor-adapter creds from env (KYC/PSP/notify), no secret/PII leaks, Zod-validated input                   | general (overview) |
| 5   | Operator/domain fit        | does the change make igaming sense for this operator; launch-blockers (only if business logic changed)                              | `expert`           |

## 5. Allocate reviewers to `--agents N`

- `N` unset: one reviewer per applicable dimension (skip dimensions with no touched files).
- `N` >= applicable dimensions: extra agents split the largest dimension by file group (state the split; never silently drop files).
- `N` < applicable dimensions: merge adjacent dimensions into `N` buckets, preferring to keep 1 (OSS boundaries) and 4 (security) standalone.

Spawn all reviewers in a SINGLE message (parallel `Task` calls). Use `general-purpose` for general
dimensions with an explicit instruction to read the §3 docs first; use `expert` for the
domain-fit dimension. Pass each reviewer: the changed-file list, the base ref, its dimension
checklist, and the report-only constraint.

## 6. Evidence & confidence gate (cut false positives)

Tell every reviewer to apply this before returning, and re-apply it yourself when synthesizing:

- Every `[BLOCK]` and `[WARN]` MUST cite a concrete `file:line` AND the rule doc it violates. No location or no rule = downgrade to `[INFO]` or drop it.
- Report only high-confidence findings. If unsure whether something is a real defect vs a theoretical nit, downgrade or omit - prefer few actionable findings over flooding.
- Don't invent runtime failures you haven't traced through the code. State the trigger path or don't raise it.
- Don't bikeshed and don't duplicate what tooling already enforces: oxlint and the `/check` gate (`pnpm typecheck`, `pnpm lint`). For a suspected lint/boundary issue, say "confirm with `pnpm lint`" rather than guessing - flag only what those gates miss.
- Each reviewer self-checks before returning: every finding has evidence + a cited rule, uncertain claims downgraded, no style nitpicks lint already catches, no unverified runtime claims.

## 7. Synthesize

Collect all findings, dedup by `file:line`, and merge into one report. Each finding:

- `[BLOCK]` - must fix before merge (edits OSS core, boundary break, authz/secret/PII risk, broken extension wiring).
- `[WARN]` - should fix (convention violation, missing test, weak input validation).
- `[INFO]` - FYI / hardening.

Group by dimension, ordered BLOCK -> WARN -> INFO. Each line:
`[SEV] file:line - finding - evidence - rule cited - fix`. BLOCK/WARN without a `file:line` and a
cited rule do not ship - they were already dropped by the gate in §6. Lead with a one-line summary:
counts per severity + verdict. End with **APPROVED** / **CHANGES REQUESTED** and the single most
critical finding.

If `--fix`: after the report, apply BLOCK + WARN fixes in the working tree (smallest diff that
satisfies the cited rule), then run the `/check` gate (`pnpm typecheck && pnpm lint`)
and report green/red. Leave INFO items untouched. Never commit or push.

## Constraints

- Read-only by default; `--fix` edits the working tree only - no commit, no push.
- NEVER edit `@openora/*` core or `node_modules` - this repo extends the platform from the outside only.
- Reviewers report findings; they do not edit. Only the orchestrator edits, and only under `--fix`.
- Always cite the rule doc a finding rests on - no opinions ungrounded in the conventions.
- Cap at 5 parallel reviewers.
