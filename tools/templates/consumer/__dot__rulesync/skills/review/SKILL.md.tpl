---
name: review
targets: ['*']
description: Multi-agent code review of the working branch against this repo's conventions, OSS-core boundaries, frontend rules, security, and operator-domain fit. Fans out a configurable number of parallel reviewers, each grounded in the rule docs, then synthesizes one verdict. Use on "review this", "code review", "/review", optionally "--agents N", "--base <ref>", "--fix", "--post" (publish findings to the pull request as inline comments + a summary verdict), "--yes" (post without confirming), "--ci" (non-interactive, exit code from the verdict), a pull-request number, or paths.
---

# review ({{name}})

You are the orchestrator: scope the diff, fan out N reviewers across dimensions, dedup findings, report ONE verdict. Report-only unless `--fix`.

Checklist - tick as you go:

```
- [ ] 1. Parse args (--agents / --base / MR# / paths / --fix / --post / --yes / --ci)
- [ ] 2. Scope the diff; if empty, ask (or APPROVED under --ci)
- [ ] 3. Collect task context (ticket AC + MR discussion)
- [ ] 3c. Trace each changed entry point end to end + check the blast radius
- [ ] 4. Pick applicable dimensions; small diff -> review inline, else spawn reviewers in ONE message
- [ ] 5. Dedup + apply the evidence gate
- [ ] 6. Report one verdict (+ apply fixes only if --fix)
- [ ] 7. Post to the MR as inline comments + summary (only if --post)
```

## 1. Parse `$ARGUMENTS`

- `--agents N` - parallel reviewers (1-5); default one per applicable dimension.
- `--base <ref>` - diff base; default `{{mrTarget}}`.
- `<number>` - a pull request: read its patch and intent with the commands in `docs/agents/forge.md`.
- paths - restrict review to those files/dirs.
- `--fix` - apply BLOCK/WARN fixes after the review; default report-only.
- `--post` - publish findings to the pull request as inline diff-line comments + a one-line summary verdict (§8). Requires a pull-request number. Draft-and-confirm by default.
- `--yes` - with `--post`, skip the confirmation and publish straight away.
- `--ci` - non-interactive: never ask, never post, never fix; print only the §7 machine block. The model cannot set the process exit code; the CI job derives it from the last line, e.g. `claude -p '/review --ci' | tee review.txt | grep -q '^VERDICT: APPROVED'`. An empty diff is APPROVED with zero findings.

## 2. Scope the diff

`git diff <base>...HEAD --name-only`; if empty, fall back to `git status -s`; if still empty, ask (under `--ci`: APPROVED, zero findings). Group changed files by app/package so reviewers and any file-split share the same map. Note the total changed-line count - it picks the mode in §4.

## 2b. Collect task context (mandatory - this is the spec axis)

Distill everything here into ONE context block of at most ~40 lines; it is the only task context reviewers receive.

- **Ticket - read it whole, per `docs/agents/issue-tracker.md`.** Resolve the `{{trackerKey}}-n` key from the MR description (`Closes {{trackerKey}}-n`), MR title, branch, or commit subjects. Read: description + AC, every comment, every attached image viewed as pixels, parent epic, linked issues, and every wiki page the ticket links (their images and comments too). Use a reader that returns image bytes (for Jira + Confluence: the `atlassian-read` skill - `read.py issue {{trackerKey}}-n`, then `page <id>` per linked page - or REST); the Atlassian MCP returns none, so it is never enough on its own. A chat thread is optional: read it (via `slack-reader` when available) only when the ticket or MR points at one ("shared in chat", a Slack link) and the AC depend on it.
- **Distill:** goal in one line; AC quoted verbatim as bullets (a `CRITERION:` line needs the exact bullet); decisions and open questions from comments (who, when); design references (which screenshot shows what); out-of-scope lines.
- **Pull-request discussion.** If reviewing one: read its intent and unresolved threads per `docs/agents/forge.md`. Distill to stated intent + open reviewer asks, so the review doesn't repeat or contradict them. No pull request: use branch commit subjects as intent.
- **No key** -> write `no ticket` in the report and judge against the MR description only. **Fetch failed** -> write `no access`. Never skip silently, never invent AC.
- A UI change whose ticket carries design screenshots is judged against them: compare the rendered UI (`playwright-cli` screenshot when the stack is up) with the reference; when you cannot, the CRITERION is `not verifiable`, never `met`.
- The MR description is the author's claim, not the spec. Where it contradicts the ticket or the diff, that contradiction is a finding.

## 3. Ground every reviewer (mandatory)

Each reviewer MUST read the changed code AND the rule docs owning its dimension before judging - never infer behavior from a diff hunk; if a finding depends on a called function, open it. Cite the docs in findings:

- `.claude/rules/conventions.md` - the always-on code standard, with a table routing to the deep-dive file in `docs/standards/`.
- `.claude/rules/frontend-conventions.md` + `docs/standards/frontend.md` - React/UI rules (React Compiler, daisyUI, module isolation) when the diff touches a UI app or the shared UI package.
- `.claude/rules/oss-boundaries.md` - OSS core read-only; enforced import boundaries.
- `.claude/rules/db-conventions.md` + `docs/standards/database.md` - SQL/Drizzle rules for overlay tables.
- `.claude/rules/overview.md` (and `.claude/rules/workflow.md` when this repo ships one) - how this repo operates.

## 3b. Stance - assume the change is broken

Review to falsify, not to confirm. Every reviewer (and you, on the fast path) starts from "this code does not work" and lets the diff earn correctness:

- For each changed behavior, trace the concrete execution path with real inputs - happy path plus at least one hostile one (empty/`''`/`0`, error, unauthorized, concurrent/repeat) - until you hit a defect or prove it sound. Reading the diff hunk is never enough.
- Verify the called API actually behaves as the code assumes - open the callee or check current docs. Watch for falsy-vs-nullish, off-by-default options, swallowed rejections, partial failure mid-flow.
- Author claims prove nothing: commit message, comments, green gates, and "obviously correct" wrappers are not evidence.
- Skepticism picks what to dig into; §6 still decides what becomes a finding - only a traced trigger path qualifies.

## 3c. Request trace - end to end, then blast radius (mandatory)

Applies to every change that crosses a layer: an oRPC route, a service, a Drizzle query, a table, an event, or a job. Skip only for a change inside one pure function, a test, a doc, or a type. Money, wallet, payment, auth/session, KYC, and RG paths always get a trace.

**Walk the hops.** For each changed route or entry point, list the hops in order and open the code at each one - the diff hunk is never enough:

1. Contract - the input schema is the only input; every field the handler reads is declared and validated.
2. Handler - guards run first; the operator, player, or actor id comes from the session, never from the body.
3. Service - open every callee; typed failures return, unexpected errors do not leak to the client.
4. Query - every read and write filters by owner/tenant; a write and its ledger/audit row share one transaction.
5. Table - the invariant lives in a constraint, index, or FK per `docs/standards/database.md`, not only in code; a migration exists for every schema change.
6. Side effects - an event, job, or outbox message fires after commit and its handler is safe to run twice.
7. Response - output matches the contract schema and leaks no extra field; each error path returns the code the client expects.

**Check the blast radius.** The change must not break a part it does not name. Build the caller list with `git grep -w -- <symbol> -- '*.ts' '*.tsx' '*.sql'` for each changed export, table symbol, and SQL table name, then confirm each use still holds:

- A changed table, column, enum, or constraint: every query, migration, seed, and schema export that touches it.
- A changed query or repository function: every caller, traced through hops 4-7.
- A changed service function: every caller, including jobs, event handlers, and other modules.
- A changed contract or shared type: every consumer, including the UI apps and the shared UI package.
- A changed event or job payload: every handler, and that it accepts the old and the new shape during rollout.

**Check the migration.** For each changed `.sql` under `drizzle/migrations/`, read the SQL. A `DROP`, a `RENAME`, or a column type change breaks the instances still running the previous release - `[BLOCK]` in the same MR as the reader change; it ships in a later release, after every reader of the old shape is deployed. A new `NOT NULL` column without a default fails on existing rows - `[BLOCK]`. Expand first, contract later. A hand-edited migration is a `[BLOCK]` (`docs/standards/database.md`).

**Prove with tests.** The orchestrator may run the tests of a touched module, never the full gate: `pnpm vitest related <path>` for each caller in the blast radius, or the one `apps/e2e` spec that drives the changed route. A failing test is a `[BLOCK]` with the test name as evidence; a caller with no test is `[INFO]`, not a request to write one.

**Report the trace.** One `TRACE:` line per entry point (format in §7). A missing hop, an unfiltered query, a write outside the transaction, or a caller that no longer holds is a `[BLOCK]`. A hop that could not be traced is a finding, not a silent pass.

## 4. Dimensions

Dimensions and the roster agent that owns each - never `general-purpose`:

1. **Boundaries, conventions, frontend, perf, duplication** - `quality-reviewer` (its prompt carries the full lens checklists; always applicable).
2. **Security & secrets** - `security-reviewer`; only if overlay routes, adapters, auth/session, env/config, or money-adjacent code changed.
3. **Operator/domain fit** - `expert`; only if business logic changed AND AC exists to judge against.

**Small-diff fast path (<= 150 changed lines): no subagents.** Read the changed files in the main thread and apply the applicable agents' checklists yourself under the §3b stance (they live in `.claude/agents/<name>.md` - skim, don't spawn). This is the common case and costs a fraction of a fan-out.

## 5. Allocate to `--agents N` (large diffs only)

- N unset: one reviewer per applicable dimension.
- N > dimensions: extras are additional `quality-reviewer` instances split by file group (state the split; never silently drop files).
- N < dimensions: drop `expert` first, then merge security into quality (say so in the report).

Spawn all reviewers in a SINGLE message (parallel). Pass each: the changed-file list for its dimension (pre-grouped - reviewers never re-scope), the base ref, the §2b context block, the §3b stance verbatim, the §3c trace for its file group, and hard caps: read only changed files + immediate callees; max 10 findings; compact `[SEV] file:line - finding - evidence - fix` lines, no prose; do NOT run `/check`/tests.

## 6. Evidence gate (cut false positives)

Every reviewer applies this before returning; re-apply it yourself when synthesizing:

- Every `[BLOCK]`/`[WARN]` cites a concrete `file:line` AND the rule doc violated - otherwise downgrade to `[INFO]` or drop.
- High-confidence findings only; unsure = downgrade or omit. Few actionable findings beat flooding.
- No invented runtime failures - state the trigger path or don't raise it.
- Don't duplicate what tooling enforces (oxlint, the `/check` gate); for a suspected lint/boundary issue say "confirm with `pnpm check:lint`" - flag only what the gates miss.

## 7. Synthesize

Dedup by `file:line`, order BLOCK -> WARN -> INFO.

Default and `--post`: a human-readable report - one line per finding `[SEV] file:line - finding - evidence - rule cited - fix`, one `TRACE:` line per traced entry point (format below), one status line per AC bullet, and **APPROVED** / **CHANGES REQUESTED** with the most critical finding last. `--post` rewrites those findings into the §8 comments.

`--ci`: print exactly this block and nothing else - a CI job parses it line by line:

```text
FINDING: [BLOCK|WARN|INFO] <file>:<line> - <finding> - <evidence> - <rule cited> - <fix>
TRACE: <entry point> - hops <n>/7 walked - callers <checked>/<found> - <ok|BLOCK reason>
CRITERION: <acceptance criterion> - <met|not met|not verifiable>
VERDICT: <APPROVED|CHANGES REQUESTED> - <counts per severity> - <most critical finding>
```

One `TRACE:` line per traced entry point, one `CRITERION:` line per AC bullet, exactly one `VERDICT:` line, last. A `[BLOCK]` of any kind, an unmet AC, or a trace failure forces CHANGES REQUESTED.

Spec findings cite the ticket the way code findings cite a rule doc: a diff that crosses a ticket's out-of-scope line, answers an open question in code without recording it on the ticket, or ships behavior no AC asked for is a `[WARN]` with the ticket line quoted as evidence.

Severities: `[BLOCK]` must fix before merge (core edit, boundary break, authz/secret/PII risk, broken extension wiring, a §3c trace failure); `[WARN]` should fix (convention violation, missing test, weak validation); `[INFO]` FYI / hardening.

If `--fix`: apply BLOCK + WARN fixes in the working tree (smallest diff satisfying the cited rule), run `/check`, report green/red. Leave INFO untouched. Never commit or push.

## 8. Post to the pull request (`--post`)

Only when `--post` is set and the target is a pull-request number. Turns findings into terse review comments: one line each, brief why, backtick every identifier.

Post BLOCK + WARN as inline threads; include INFO only if it maps to a concrete `file:line`. One comment per finding, one line each.

1. **Draft.** Rewrite each finding as a terse comment keyed to its `file:line`. Compose the summary as ONE sentence stating whether the changes block prod/push, e.g. `Not a blocker for push - a few cleanups worth doing.` or `Blocker: the finding in `x.ts` must be fixed before we push.`
2. **Confirm.** Show all drafted comments + the summary and stop for approval - UNLESS `--yes`, then skip straight to posting.
3. **Post inline comments** anchored to the diff, using the "Inline review comments" command in `docs/agents/forge.md`. Anchor on the NEW-file line of an added (`+`) line (`git show <src-branch>:<file> | grep -n`), and verify each response actually carries a line anchor - an unanchored fallback comment must be deleted and retried, never left behind.
4. **Post the summary** as one general comment on the pull request, per the same file.
5. Report back the count posted + the summary verdict. Never resolve threads; never push.

## Constraints

- Reviewers report; only the orchestrator edits, and only under `--fix` (working tree only - no commit, no push).
- Never `git stash`, never `git checkout` another branch in the working tree: read MR sources with `git fetch` + `git show <sha>:<path>` / `git diff <base> <head>`. The stash stack and the worktree are shared with other sessions.
- NEVER edit `@openora/*` core or `node_modules`.
- Every finding cites a rule doc - no ungrounded opinions.
- Cap at 5 parallel reviewers.
