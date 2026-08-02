---
name: review
targets: ['*']
description: Multi-agent code review of the working branch against this repo's conventions, OSS-core boundaries, frontend rules, security, and operator-domain fit. Fans out a configurable number of parallel reviewers, each grounded in the rule docs, then synthesizes one verdict. Use on "review this", "code review", "/review", optionally "--agents N", "--base <ref>", "--fix", "--post" (publish findings to the MR as inline comments + a summary verdict), "--yes" (post without confirming), a GitLab MR number, or paths.
---

# review

You are the orchestrator: scope the diff, fan out N reviewers across dimensions, dedup findings, report ONE verdict. Report-only unless `--fix`.

Checklist - tick as you go:

```
- [ ] 1. Parse args (--agents / --base / MR# / paths / --fix / --post / --yes)
- [ ] 2. Scope the diff; if empty, ask
- [ ] 3. Collect task context (ticket AC + MR discussion)
- [ ] 4. Pick applicable dimensions; small diff -> review inline, else spawn reviewers in ONE message
- [ ] 5. Dedup + apply the evidence gate
- [ ] 6. Report one verdict (+ apply fixes only if --fix)
- [ ] 7. Post to the MR as inline comments + summary (only if --post)
```

## 1. Parse `$ARGUMENTS`

- `--agents N` - parallel reviewers (1-5); default one per applicable dimension.
- `--base <ref>` - diff base; default `dev`.
- `<number>` - a GitLab MR: `glab mr diff <n>` for the patch, `glab mr view <n>` for intent.
- paths - restrict review to those files/dirs.
- `--fix` - apply BLOCK/WARN fixes after the review; default report-only.
- `--post` - publish findings to the GitLab MR as inline diff-line comments + a one-line summary verdict (§8). Requires an MR number. Draft-and-confirm by default.
- `--yes` - with `--post`, skip the confirmation and publish straight away.

## 2. Scope the diff

`git diff <base>...HEAD --name-only`; if empty, fall back to `git status -s`; if still empty, ask. Group changed files by app/package so reviewers and any file-split share the same map. Note the total changed-line count - it picks the mode in §4.

## 2b. Collect task context

Distill everything here into ONE context block of at most ~30 lines; it is the only task context reviewers receive.

- **Ticket.** Extract the BF key from the branch name / MR title. Fetch it (Atlassian MCP or REST) and distill: goal in one line + acceptance criteria as bullets. No key or no access: skip silently.
- **MR discussion.** If reviewing an MR: `glab mr view <n>` + unresolved discussion threads. Distill to stated intent + open reviewer asks, so the review doesn't repeat or contradict them. No MR: use branch commit subjects as intent.
- The AC bullets feed the verdict (§7) - a finding "AC not met" needs a specific bullet.

## 3. Ground every reviewer (mandatory)

Each reviewer MUST read the changed code AND the rule docs owning its dimension before judging - never infer behavior from a diff hunk; if a finding depends on a called function, open it. Cite the docs in findings:

- `.claude/rules/conventions.md` - the stack-agnostic code standard.
- `.claude/rules/frontend-conventions.md` - React/UI rules (React Compiler, daisyUI, module isolation) when the diff touches a UI app or the shared UI package.
- `.claude/rules/oss-boundaries.md` - OSS core read-only; enforced import boundaries.
- `.claude/rules/db-conventions.md` - SQL/Drizzle rules for overlay tables.
- `.claude/rules/workflow.md` + `.claude/rules/overview.md` - how this repo operates.

## 4. Dimensions

Dimensions and the roster agent that owns each - never `general-purpose`:

1. **Boundaries, conventions, frontend, perf, duplication** - `quality-reviewer` (its prompt carries the full lens checklists; always applicable).
2. **Security & secrets** - `security-reviewer`; only if overlay routes, adapters, auth/session, env/config, or money-adjacent code changed.
3. **Operator/domain fit** - `expert`; only if business logic changed AND AC exists to judge against.

**Small-diff fast path (<= 150 changed lines): no subagents.** Read the changed files in the main thread and apply the applicable agents' checklists yourself (they live in `.claude/agents/<name>.md` - skim, don't spawn). This is the common case and costs a fraction of a fan-out.

## 5. Allocate to `--agents N` (large diffs only)

- N unset: one reviewer per applicable dimension.
- N > dimensions: extras are additional `quality-reviewer` instances split by file group (state the split; never silently drop files).
- N < dimensions: drop `expert` first, then merge security into quality (say so in the report).

Spawn all reviewers in a SINGLE message (parallel). Pass each: the changed-file list for its dimension (pre-grouped - reviewers never re-scope), the base ref, the §2b context block, and hard caps: read only changed files + immediate callees; max 10 findings; compact `[SEV] file:line - finding - evidence - fix` lines, no prose; do NOT run `/check`/tests.

## 6. Evidence gate (cut false positives)

Every reviewer applies this before returning; re-apply it yourself when synthesizing:

- Every `[BLOCK]`/`[WARN]` cites a concrete `file:line` AND the rule doc violated - otherwise downgrade to `[INFO]` or drop.
- High-confidence findings only; unsure = downgrade or omit. Few actionable findings beat flooding.
- No invented runtime failures - state the trigger path or don't raise it.
- Don't duplicate what tooling enforces (oxlint, the `/check` gate); for a suspected lint/boundary issue say "confirm with `pnpm check:lint`" - flag only what the gates miss.

## 7. Synthesize

Dedup by `file:line`, group by dimension, order BLOCK -> WARN -> INFO. Each line: `[SEV] file:line - finding - evidence - rule cited - fix`. Lead with a one-line summary (counts per severity + verdict); end with **APPROVED** / **CHANGES REQUESTED** + the single most critical finding.

Severities: `[BLOCK]` must fix before merge (core edit, boundary break, authz/secret/PII risk, broken extension wiring); `[WARN]` should fix (convention violation, missing test, weak validation); `[INFO]` FYI / hardening.

If `--fix`: apply BLOCK + WARN fixes in the working tree (smallest diff satisfying the cited rule), run `/check`, report green/red. Leave INFO untouched. Never commit or push.

## 8. Post to the MR (`--post`)

Only when `--post` is set and the target is an MR number. Turns findings into terse review comments: one line each, brief why, backtick every identifier.

Post BLOCK + WARN as inline threads; include INFO only if it maps to a concrete `file:line`. One comment per finding, one line each.

1. **Draft.** Rewrite each finding as a terse comment keyed to its `file:line`. Compose the summary as ONE sentence stating whether the changes block prod/push, e.g. `Not a blocker for push - a few cleanups worth doing.` or `Blocker: BLOCK finding in `x.ts` must be fixed before we push.`
2. **Confirm.** Show all drafted comments + the summary and stop for approval - UNLESS `--yes`, then skip straight to posting.
3. **Post inline comments** as positional discussions on the diff. Mechanics + gotchas are in the Notion memory `glab MR inline diff-line comments (positional discussions)` (query the Memories DB) - the short of it:
   - Diff SHAs from `glab api "projects/consumer%2Fconsumer/merge_requests/<n>" | jq .diff_refs`.
   - Anchor on the NEW-file line of an added (`+`) line (`git show <src-branch>:<file> | grep -n`).
   - POST JSON (build with Python `json.dumps` to dodge quoting) to `.../merge_requests/<n>/discussions` with a `position` object; `glab api -H "Content-Type: application/json" ... --input -`. Do NOT use `-f "position[...]"` - nested params silently drop the position.
   - Verify each response's `.notes[0].position.new_line`; if null it fell back to a general note - delete (`glab api -X DELETE .../notes/<id>`) and retry.
4. **Post the summary** as one general MR note (`glab mr note <n> -m "<one sentence>"`).
5. Report back the count posted + the summary verdict. Never resolve threads; never push.

## Constraints

- Reviewers report; only the orchestrator edits, and only under `--fix` (working tree only - no commit, no push).
- NEVER edit `@openora/*` core or `node_modules`.
- Every finding cites a rule doc - no ungrounded opinions.
- Cap at 5 parallel reviewers.
