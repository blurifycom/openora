---
name: oss-review
description: >-
  Multi-agent code review of the working branch against this repo's conventions,
  boundaries, contracts, security, messaging, and audit rules. Fans out a
  configurable number of parallel reviewers, each grounded in the rule docs,
  then synthesizes one verdict. Use on "review this", "oss review",
  "/oss-review", optionally "--agents N", "--base <ref>", "--fix", a GitHub PR
  number, or paths.
---

# oss-review

Orchestrate a parallel, convention-grounded code review of the current change set. You are the
orchestrator: scope the diff, fan out N reviewers across review dimensions, dedup their findings,
and report ONE verdict. Report-only by default - never edit unless `--fix` is passed.

Copy this checklist and tick it off as you go:

```
oss-review:
- [ ] 1. Parse args (--agents / --base / PR# / paths / --fix)
- [ ] 2. Scope the diff; if empty, ask
- [ ] 3. Pick applicable dimensions (only those with touched files)
- [ ] 4. Spawn reviewers in ONE message (parallel)
- [ ] 5. Dedup + apply the evidence/confidence gate
- [ ] 6. Report one verdict (+ apply fixes only if --fix)
```

## 1. Parse `$ARGUMENTS`

| Token               | Meaning                                                       | Default                         |
| ------------------- | ------------------------------------------------------------- | ------------------------------- |
| `--agents N`        | how many parallel reviewers to spawn (1-6)                    | one per applicable dimension    |
| `--base <ref>`      | branch to diff against                                        | `dev` (this repo's integration) |
| `<number>` (e.g. 8) | a GitHub PR number - review that PR's diff (`gh pr diff <n>`) | -                               |
| paths               | restrict review to these files/dirs                           | whole diff                      |
| `--fix`             | apply fixes for `[BLOCK]`/`[WARN]` findings after the review  | off (report only)               |

## 2. Scope the diff (do this first)

- Branch: `git diff <base>...HEAD --name-only` (default base `dev`). If empty, fall back to
  unstaged/staged via `git status -s`; if still empty, ask what to review.
- PR number given: `gh pr diff <n>` for the patch + `gh pr view <n>` for intent.
- Group changed files by package/domain so reviewers and any file-split share the same map.

## 3. Ground every reviewer (mandatory)

Each spawned reviewer MUST read the actual changed code AND the rule docs that own its dimension
before judging - do not infer behavior from a diff hunk. If a finding depends on what a called
function does, open it; if you can't cite it, fetch it. These docs are the single source of truth -
cite them in findings:

- `.claude/rules/conventions.md` - the portable code standard (philosophy, naming, types, functions, comments, testing, errors, deps, git).
- `.claude/rules/clean-architecture.md` - add-on layering, DI, ports & adapters, shared helpers, FK rule.
- `.claude/rules/messaging-and-microservices.md` - command vs event vs job, outbox, service manifest.
- `CLAUDE.md` (AGENTS.md) - architecture pillars, dependency rules, forbidden patterns, the "Definition of done" audit requirement.
- The touched module's own `AGENTS.md` and any relevant `docs/adr/*.md`.

## 4. Review dimensions

Each dimension maps to a rule doc and, where one exists, a pre-scoped roster subagent. Spawn only the
dimensions whose files actually changed.

| #   | Dimension              | Covers                                                                                   | Use subagent             |
| --- | ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------ |
| 1   | Boundaries & contracts | import-graph rules, oRPC `.input()/.output()`, Zod-first, schema/openapi drift, drizzle  | `contract-reviewer`      |
| 2   | Security & money       | money idempotency/atomicity, authz/`AdminGuard`, secrets/PII, auth flows, injection      | `security-reviewer`      |
| 3   | Conventions & quality  | naming, functional/immutable, no `any`/`interface`/default-export, comments WHY, tests   | general (grounded in §3) |
| 4   | Messaging seams        | command vs event vs job choice, outbox for must-not-lose events, idempotent handlers     | general (grounded in §3) |
| 5   | Audit completeness     | every state-changing action leaves a hash-chained `audit` entry (domain event or writer) | general (grounded in §3) |
| 6   | Operator/domain fit    | does the change make igaming sense; launch-blockers (only if business logic changed)     | `operator`               |

## 5. Allocate reviewers to `--agents N`

- `N` unset: one reviewer per applicable dimension (skip dimensions with no touched files).
- `N` >= applicable dimensions: extra agents split the largest dimension by file group (state the split with `log`/prose; never silently drop files).
- `N` < applicable dimensions: merge adjacent dimensions into `N` buckets, preferring to keep 1 (boundaries/contracts) and 2 (security) standalone.

Spawn all reviewers in a SINGLE message (parallel `Task` calls). Prefer the roster subagent named in
the table; for general dimensions use `general-purpose` with an explicit instruction to read the §3
docs first. Pass each reviewer: the changed-file list, the base ref, its dimension checklist, and the
report-only constraint.

## 6. Evidence & confidence gate (cut false positives)

Tell every reviewer to apply this before returning, and re-apply it yourself when synthesizing:

- Every `[BLOCK]` and `[WARN]` MUST cite a concrete `file:line` AND the rule doc/ADR it violates. No location or no rule = downgrade to `[INFO]` or drop it.
- Report only high-confidence findings. If unsure whether something is a real defect vs a theoretical nit, downgrade or omit - prefer few actionable findings over flooding.
- Don't invent runtime failures you haven't traced through the code. State the trigger path or don't raise it.
- Don't bikeshed and don't duplicate what tooling already enforces: oxlint (`oss-boundaries/*`, `no-any`, `consistent-type-definitions`), `pnpm boundaries`, and `pnpm verify` run in CI. For a suspected boundary/lint issue, say "confirm with `pnpm boundaries`" rather than guessing - flag only what those gates miss.
- Each reviewer self-checks before returning: every finding has evidence + a cited rule, uncertain claims downgraded, no style nitpicks lint already catches, no unverified runtime claims.

## 7. Synthesize

Collect all findings, dedup by `file:line`, and merge into one report. Each finding:

- `[BLOCK]` - must fix before merge (boundary/contract break, money/authz/PII risk, missing audit on a mutation, schema drift without `pnpm regen`).
- `[WARN]` - should fix (convention violation, weak idempotency, missing test).
- `[INFO]` - FYI / hardening.

Group by dimension, ordered BLOCK -> WARN -> INFO. Each line:
`[SEV] file:line - finding - evidence - rule/ADR cited - fix`. BLOCK/WARN without a `file:line` and a
cited rule do not ship - they were already dropped by the gate in §6. Lead with a one-line summary:
counts per severity + verdict. End with **APPROVED** / **CHANGES REQUESTED** and the single most
critical finding.

If `--fix`: after the report, apply BLOCK + WARN fixes in the working tree (smallest diff that
satisfies the cited rule), then run `pnpm verify` (or `pnpm boundaries` for boundary fixes) and report
green/red. Leave INFO items untouched. Never commit or push.

## Constraints

- Read-only by default; `--fix` edits the working tree only - no commit, no push.
- Reviewers report findings; they do not edit. Only the orchestrator edits, and only under `--fix`.
- Always cite the rule doc + ADR a finding rests on - no opinions ungrounded in the conventions.
- Cap at 6 parallel reviewers.
