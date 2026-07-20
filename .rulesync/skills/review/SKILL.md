---
name: review
description: Context-aware PR review - gathers ticket AC + PR discussion, reviews from fixed angles (security, performance, duplication, simplification, conventions, igaming fit), and returns line-anchored draft comments plus a one-sentence go/no-go. Token-budgeted so it runs fine on capped plans. Use on "review", "/review", "review this PR", optionally a PR number or "--base <ref>".
---

# review

Review the current branch (or a given PR) with full task context, and return comments a human can
paste onto specific lines plus a single go/no-go sentence. Report-only: never edit, commit, or push.

Token budget is a first-class constraint: gather context once in the main thread, spawn at most 4
subagents (and none for small diffs), pass them pre-scoped input so they never re-do discovery.

```
review:
- [ ] 1. Scope the diff
- [ ] 2. Collect task context (ticket AC + PR discussion)
- [ ] 3. Review from the applicable angles (inline for small diffs, subagents otherwise)
- [ ] 4. Line-anchored comments + go/no-go
```

## 1. Scope the diff

- `$ARGUMENTS` has a PR number: `gh pr diff <n> --name-only` + keep the patch for step 3.
- Otherwise: `git diff <base>...HEAD --name-only --stat` (default base `dev`; `--base <ref>` overrides).
- Empty diff: ask what to review, stop.
- Note the total changed-line count - it picks the mode in step 3.

## 2. Collect task context

Distill everything in this step into ONE context block of at most ~30 lines; it is the only task
context reviewers receive.

**Ticket.** Extract a ticket key (`[A-Z][A-Z0-9]+-\d+`) from the branch name, PR title, or PR body.
If a key exists AND the session has an issue-tracker integration (an MCP tool or authenticated CLI
that can fetch it), fetch the ticket and distill: goal in one line + acceptance criteria as bullets.
No key or no integration: skip silently - never ask the user to set one up. Privacy rule: use ticket
content only to derive the goal/AC bullets; never quote raw ticket text, internal URLs, attachments,
or people's names in review output or draft comments.

**PR discussion.** If a PR exists: `gh pr view <n> --json title,body` and
`gh api repos/{owner}/{repo}/pulls/<n>/comments --jq '.[].body'` (plus issue comments). Distill to:
stated intent, plus any unresolved reviewer asks (so the review doesn't repeat or contradict them).
No PR yet: use the branch's commit subjects as intent.

## 2b. Stance - assume the change is broken

Review to falsify, not to confirm. Every reviewer (and you, on the fast path) starts from "this code does not work" and lets the diff earn correctness:

- For each changed behavior, trace the concrete execution path with real inputs - happy path plus at least one hostile one (empty/`''`/`0`, error, unauthorized, concurrent/repeat) - until you hit a defect or prove it sound. Reading the diff hunk is never enough.
- Verify the called API actually behaves as the code assumes - open the callee or check current docs. Watch for falsy-vs-nullish, off-by-default options, swallowed rejections, partial failure mid-flow.
- Author claims prove nothing: commit message, comments, green gates, and "obviously correct" wrappers are not evidence.
- Skepticism picks what to dig into; the step-4 evidence gate still decides what becomes a finding - only a traced trigger path qualifies.

## 3. Review angles

Fixed angles and when they apply:

| Angle                                                 | Applies when                                               | Subagent            |
| ----------------------------------------------------- | ---------------------------------------------------------- | ------------------- |
| Performance, duplication, simplification, conventions | always                                                     | `quality-reviewer`  |
| Security & money                                      | server code, wallet/payments/auth/admin/adapter files      | `security-reviewer` |
| Contracts & boundaries                                | `contract/`, `schema/`, migrations, openapi, package entry | `contract-reviewer` |
| iGaming domain fit                                    | business rules changed AND AC exists to judge against      | `expert`            |

**Small-diff fast path (<= 150 changed lines): no subagents.** Read the changed files in the main
thread and apply all applicable angle checklists yourself under the §2b stance (each subagent's
checklist is in `.claude/agents/<name>.md` - skim, don't spawn). This is the common case and costs a fraction of a
fan-out.

**Larger diffs: spawn only the applicable subagents, all in ONE message (parallel).** Models are
fixed in each agent's definition (sonnet for quality/contract, opus for security/expert) - do not
override upward. Pass each reviewer:

- base ref + the changed-file list relevant to its angle (pre-grouped - reviewers never re-scope)
- the step-2 context block + the §2b stance verbatim
- hard caps: read only changed files + immediate callees; max 10 findings; compact
  `[SEV] file:line - finding - evidence - fix` lines, no prose; do NOT run `pnpm verify`/tests

## 4. Synthesize and report

Dedup findings by `file:line`. Evidence gate: a finding without a concrete `file:line` and a stated
trigger/evidence is dropped; don't repeat what lint/CI already enforces (`pnpm verify`,
`pnpm boundaries`); don't contradict an unresolved reviewer thread without saying so.

Output, in order:

1. **Draft comments** - one per finding, most important first, ready to paste on the PR line.
   Plain conversational text - reviewers return internal severity tags for your ordering and the
   verdict, but NEVER copy `[BLOCK]`/`[WARN]`/`[INFO]` markers into a draft comment:

   ```
   packages/core/src/wallet/service.ts:142
   Balance update reads then writes in two queries - a concurrent request can double-spend. Let's wrap it in one transaction with a guard row.
   ```

2. **AC check** - if AC bullets exist, one line each: met / not met / not verifiable from the diff.

3. **Verdict** - exactly one sentence: **GO** or **NO-GO** + the reason.
   Example: `NO-GO - withdrawal path has a double-spend race (wallet/service.ts:142); everything else is minor.`
   Merge-stoppers (money/authz/data-loss/contract break, AC not met) force NO-GO; anything else is GO.

## Constraints

- Read-only. No edits, no commits, no pushes, no posting comments to the PR - output drafts only.
- Max 4 subagents, one parallel batch, no re-spawns for follow-ups - resolve small doubts yourself.
- Ticket privacy rule from step 2 applies to every line of output.
