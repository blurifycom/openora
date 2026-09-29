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
- [ ] 2. Run the precheck: scope, mechanical facts, domain hits; if empty, ask (or APPROVED under --ci)
- [ ] 2a. Previous review? Go incremental from its SHA and carry its findings
- [ ] 3. Collect task context (ticket AC + MR discussion)
- [ ] 3a. Paired OSS change? Review the OSS diff by the OSS rules + cross-check the contract (§2c)
- [ ] 3c. Trace each changed entry point end to end + check the blast radius
- [ ] 4. Cover all seven dimensions; spawn the two-lens roster in ONE message, whatever the diff size
- [ ] 5. Dedup + apply the evidence gate
- [ ] 6. Report one DIMENSION line per dimension + one verdict (+ apply fixes only if --fix)
- [ ] 7. Post to the MR as inline comments + summary (only if --post)
```

## 1. Parse `$ARGUMENTS`

- `--agents N` - parallel reviewers (2-4); default 2 (§5).
- `--base <ref>` - diff base; default `{{mrTarget}}`.
- `--full` - ignore the previous review (§2a) and review the whole change.
- `<number>` - a pull request: read its patch and intent with the commands in `docs/agents/forge.md`.
- paths - restrict review to those files/dirs.
- `--fix` - apply BLOCK/WARN fixes after the review; default report-only.
- `--post` - publish findings to the pull request as inline diff-line comments + a one-line summary verdict (§8). Requires a pull-request number. Draft-and-confirm by default.
- `--yes` - with `--post`, skip the confirmation and publish straight away.
- `--ci` - non-interactive: never ask, never post, never fix; print only the §7 machine block. Implies `--full`: a gate never trusts a prior-review marker, since anyone who can comment on the pull request can post one for the current head. The model cannot set the process exit code; the CI job derives it from the output, e.g. `claude -p '/review --ci' > review.txt; [ "$(grep -c '^DIMENSION: ' review.txt)" -eq 7 ] && grep -q '^VERDICT: APPROVED' review.txt` - a review that skipped a dimension fails the job even when it approves. An empty diff is APPROVED with zero findings.

## 2. Scope the diff

**Reviewing a pull request by number:** reviewers need files to open, and the working tree is not theirs to switch. Fetch the source branch and add a detached worktree at the pull request's head SHA, never at `FETCH_HEAD` (a failed fetch leaves it pointing at the previous ref): `git fetch origin <src-branch> && git worktree add --detach .claude/worktrees/review-<n> <head-sha>` and `pnpm install --offline --frozen-lockfile` in it (the tests in §3c need it), then confirm `git -C .claude/worktrees/review-<n> rev-parse HEAD` equals `<head-sha>` and stop if it does not. An existing `review-<n>` worktree is reset to `<head-sha>`, not reused as is. Pass the worktree path to every reviewer and remove it with `git worktree remove` after §7.

**Run the precheck before anything else reads code.** From the directory under review (the review worktree, or the working tree), run the main checkout's script - it is rendered and gitignored, so a worktree lacks it: `node <main-checkout>/tools/review-precheck.mjs --base origin/<base>` (add `--since <sha>` from §2a). It costs no tokens beyond its output and replaces what reviewers used to derive by reading:

- `SCOPE:` - mode (`full` / `incremental`) and the reviewable changed-line count that sets the split and budgets in §5.
- `RISK:` - `low`, `medium`, `high`, or `critical` from the changed paths and domain hits; it sets the reviewer effort in §5. Never judge risk from the title or the line count: a 30-line change can add a route, a table, or a migration. The tier is a floor: after reading the diff you may raise it (a component rendering untrusted HTML, a hook that moves money), never lower it; say why in the report.
- `REVIEWABLE:` - the only file list reviewers get. Group these by app/package so reviewers and any file split share one map.
- `SKIPPED:` - lockfiles, locale data, tests, generated files. No reviewer opens them; the precheck's i18n facts and CI's frozen-lockfile install stand in. List them in the report so nothing is silently dropped.
- `PRECHECK:` - mechanical hits on added lines (casts, widened maps, hardcoded limits, hand memo, banned classes, locale parity, missing keys). Reviewers judge these; they never re-derive them.
- `DOMAIN:` / `DOMAIN-HIT:` - security and compliance keyword hits; they pick each reviewer's mode in §5.

No `REVIEWABLE:` and no `SKIPPED:` lines: fall back to `git status -s`; if still empty, ask (under `--ci`: APPROVED, zero findings).

**Rule docs live in the main checkout, not the review worktree.** `.claude/rules/`, `.rulesync/rules/`, `docs/standards/`, and `docs/agents/` are rendered by `pnpm sync:agents` + `pnpm gen:agents` and gitignored, so a fresh worktree has none of them. Pass reviewers the absolute main-checkout path for every rule doc. When the render has not run (a CI job that skips `prepare`), run `pnpm sync:agents && pnpm gen:agents` before reviewing.

## 2a. Previous review - review only what changed since

A pull request is reviewed round after round; re-reading the whole change each round is the biggest waste. Unless `--full` or `--ci`:

1. Read `.claude/reviews/<pr>.json` in the main checkout (`{ "sha", "base", "verdict", "findings": [...], "dimensions": [...] }`; no PR number: key it by branch name). Absent and a PR number given: find the latest note carrying `<!-- review:sha=<sha> -->` per `docs/agents/forge.md` and take its SHA; its findings are the inline threads still unresolved.
2. Found: run the precheck with `--since <sha>`. `mode incremental` narrows `REVIEWABLE:`, its line counts, `PRECHECK:`, and `DOMAIN-HIT:` to what changed since that review (base-branch merges excluded). A `NOTE: --since ... not an ancestor` (force push, rebase) means a full review - say so.
3. Split the prior findings: those on a file in the new `REVIEWABLE:` set go to the owning reviewer to re-verify; the rest carry over unchanged.

## 2b. Collect task context (mandatory - this is the spec axis)

Distill everything here into ONE context block of at most ~40 lines; it is the only task context reviewers receive.

- **Ticket - read it whole, per `docs/agents/issue-tracker.md`.** Resolve the `{{trackerKey}}-n` key from the MR description (`Closes {{trackerKey}}-n`), MR title, branch, or commit subjects. Read: description + AC, every comment, every attached image viewed as pixels, parent epic, linked issues, and every wiki page the ticket links (their images and comments too). Use a reader that returns image bytes (for Jira + Confluence: the `atlassian-read` skill - `read.py issue {{trackerKey}}-n`, then `page <id>` per linked page - or REST); the Atlassian MCP returns none, so it is never enough on its own. A chat thread is optional: read it (via `slack-reader` when available) only when the ticket or MR points at one ("shared in chat", a Slack link) and the AC depend on it.
- **Distill:** goal in one line; AC quoted verbatim as bullets (a `CRITERION:` line needs the exact bullet); decisions and open questions from comments (who, when); design references (which screenshot shows what); out-of-scope lines.
- **Pull-request discussion.** If reviewing one: read its description and every thread, resolved ones included, per `docs/agents/forge.md`. Distill to stated intent, open reviewer asks, and the decisions resolved threads settled (quote who asked for what and what was agreed), so the review doesn't repeat or contradict them. No pull request: use branch commit subjects as intent.
- **Reviewers have no forge access.** You own the description checks: the manual-verification evidence and the "Tests to add" list (§3c). Report them yourself; never hand them to a reviewer.
- **No key** -> write `no ticket` in the report and judge against the MR description only. **Fetch failed** -> write `no access`. Never skip silently, never invent AC.
- A UI change whose ticket carries design screenshots is judged against them: compare the rendered UI (`playwright-cli` screenshot when the stack is up) with the reference; when you cannot, the CRITERION is `not verifiable`, never `met`.
- The MR description is the author's claim, not the spec. Where it contradicts the ticket or the diff, that contradiction is a finding.

## 2c. Paired OSS change - review the platform whole (mandatory)

A consumer change is often half of a pair. The OSS half is reviewed here too, so the verdict covers the platform, not one repo.

**Find the pair** - first match wins:

1. The same branch name in `{{ossDir}}`: a worktree under `{{ossDir}}/.worktrees/`, a local branch (`git -C {{ossDir}} branch --list <branch>`), or an open OSS PR (`gh pr list --head <branch>` run in `{{ossDir}}`).
2. A changed `@openora/*` version in `package.json`. The OSS diff is the range between the two canaries: `X.Y.Z-canary.N` was built by OSS pipeline run `N`, so resolve each side with `gh run list -R blurifycom/openora -w pipeline.yml -L 500 --json number,headSha --jq '.[] | select(.number==N) | .headSha'`, then `git -C {{ossDir}} fetch origin` and `git -C {{ossDir}} diff <old-sha>...<new-sha>`.

No match: write `no paired OSS change` in the report and move on.

**Read the OSS code without touching the main checkout.** Case 1: `pnpm oss:worktree <branch>` (idempotent) and read from that worktree. Case 2: `git -C {{ossDir}} show <sha>:<path>`. Never `git checkout` in `{{ossDir}}` - other sessions build against it.

**Review the OSS diff by the OSS rules.** Read `<worktree>/docs/standards/skills/review.md` and every `<worktree>/.rulesync/rules/*.md`. Run their request trace and dimensions on `git -C <worktree> diff origin/dev...HEAD`. OSS files join §4 as their own file group, handed to `quality-reviewer` (plus `security-reviewer` for auth paths and `compliance-reviewer` for money, wallet, KYC, or RG paths) with the worktree path. Their findings are prefixed `[oss]`, cite the OSS rule or ADR, and pass the same evidence gate (§6).

**Cross-check the contract** - what neither repo's review sees alone:

- Every export, route, event payload, config field, or table the OSS diff changes: `git grep -w` it in this repo and confirm each use still compiles and still means the same thing. A consumer caller that no longer holds is a `[BLOCK]`.
- Every consumer change that relies on the OSS change (a new export, a changed signature or behavior) is matched in the OSS diff. Consumer code relying on OSS behavior the diff does not ship is a `[BLOCK]`.
- Genericity: OSS code that encodes this operator's behavior - a jurisdiction rule, a vendor, a limit or flow only this repo needs - instead of a seam (adapter token, event, config field, hook) is a `[BLOCK]`; the behavior moves here and core keeps the seam. An OSS PR whose Why does not say why the change cannot live in the consumer is a `[WARN]`.
- Public record: operator names, internal URLs, ticket text, or operator-specific domain detail in the OSS commits or PR is a `[BLOCK]`.
- Release order: a consumer request that needs the OSS change can merge only once the `@openora/*` pin points at a canary that carries it. Say so in the report when the pin is older.
- When a trace needs runtime proof: `pnpm oss:worktree <branch> --link`, run the touched tests, then `pnpm link:oss` to restore the main checkout link.

Report `[oss]` findings and one `TRACE:` line per OSS entry point alongside the consumer ones. The verdict covers both.

## 3. Ground every reviewer (mandatory)

Each reviewer MUST read the changed code AND the rule docs owning its dimension before judging - never infer behavior from a diff hunk; if a finding depends on a called function, open it. Each agent file carries a reading map: the few docs its focus needs, not every rule. Pass the main-checkout paths; the reviewer reads only its map, and a `docs/standards/` deep dive only for the row a finding depends on.

You read `CLAUDE.md` / `AGENTS.md` (the rendered `overview` rule) and `.claude/rules/workflow.md` once, for §2b and the `rollout` and `spec` dimensions. Reviewers get the distilled context block, never those files.

No rule doc covers performance, scalability, or most security concerns. There a finding cites the named, established principle it breaks instead (N+1, unbounded list, silent truncation, authz enforced only client-side, unvalidated URL rendered to players) - §6 accepts that citation.

## 3b. Stance - assume the change is broken

Review to falsify, not to confirm. Every reviewer (and you, on `rollout` and `spec`) starts from "this code does not work" and lets the diff earn correctness:

- For each changed behavior, trace the concrete execution path with real inputs - happy path plus at least one hostile one (empty/`''`/`0`, error, unauthorized, concurrent/repeat) - until you hit a defect or prove it sound. Reading the diff hunk is never enough.
- Verify the called API actually behaves as the code assumes - open the callee or check current docs. Watch for falsy-vs-nullish, off-by-default options, swallowed rejections, partial failure mid-flow.
- Author claims prove nothing: commit message, comments, green gates, and "obviously correct" wrappers are not evidence.
- Skepticism picks what to dig into; §6 still decides what becomes a finding - only a traced trigger path qualifies.

## 3c. Request trace - end to end, then blast radius (mandatory)

Applies to every change that crosses a layer: an oRPC route, a service, a Drizzle query, a table, an event, or a job. Skip only for a change inside one pure function, a test, a doc, or a type. Money, wallet, payment, auth/session, KYC, and RG paths always get a trace.

**UI-only diff** (no route, service, query, table, event, or job changed in this repo): trace each changed data hook to the platform route it calls - hops 1, 2, and 7 only (input schema, guard, response fields) - and say so in the `TRACE:` line. The full walk is for layers this repo owns.

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

**Prove with tests.** The orchestrator may run the tests of a touched module, never the full gate: `pnpm vitest related <path>` for each caller in the blast radius, plus any existing `apps/e2e` spec that already drives the changed route. A failing test is a `[BLOCK]` with the test name as evidence; a caller with no test is `[INFO]`, not a request to write one. Tests that could not run are reported as `TESTS: not run - <reason>`, never skipped silently, and forbid APPROVED on `high` or `critical` risk.

**A feature PR ships no tests, at any tier** (`docs/standards/testing.md`) - a missing test is `[INFO]` at most, NEVER a `[BLOCK]`, and never a request to write one. What you check instead: the description carries the manual-verification evidence (a screenshot per changed screen, before/after on a fix, or the request/response trace for an API-only change) and a "Tests to add" list whose entries match the behaviour the diff actually changed. Missing evidence on a user-visible change is a `[WARN]`; a "Tests to add" list that contradicts the diff is a finding.

**Report the trace.** One `TRACE:` line per entry point (format in §7). A missing hop, an unfiltered query, a write outside the transaction, or a caller that no longer holds is a `[BLOCK]`. A hop that could not be traced is a finding, not a silent pass.

## 4. Dimensions - all seven, every review

Every review covers every dimension below, whatever the diff touches. Relevance is decided by looking, not by guessing from file names: a dimension that does not apply still runs its search and reports `n/a` with what it checked. Owners - never `general-purpose`:

| Dimension     | Owner                                     | Covers                                                                                  |
| ------------- | ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `conventions` | `quality-reviewer`                        | correctness, boundaries, conventions, UI quality (i18n, a11y, states), dependencies     |
| `performance` | `quality-reviewer`                        | performance and scalability at production scale                                         |
| `reliability` | `quality-reviewer`                        | races, double submit, retries, partial failure, cache invalidation, error handling      |
| `security`    | `security-reviewer` (focus `risk`)        | authz, secrets and PII, input validation, URLs                                          |
| `compliance`  | `security-reviewer` (focus `risk`)        | responsible gambling, KYC/age/geo gates, ledger and money paths, audit trail            |
| `rollout`     | orchestrator                              | §3c migrations, destructive seeds, event and payload compatibility, new env/config      |
| `spec`        | orchestrator                              | AC (§2b), ticket scope, manual-verification evidence and "Tests to add" (§3c)           |

`expert` is not a reviewer; ask it only when an AC is ambiguous enough to block a `CRITERION:` line.

Reviewers split by what they read, never by checklist. An agent's cost is its tool calls times its context: a checklist adds a few thousand tokens, while two reviewers reading the same files pay for those files twice.

**No inline fast path.** Every diff, however small, goes to the two lens reviewers in §5. One reviewer working every checklist finds about half of what two focused lenses find, for most of their cost; a small diff is cheap for them anyway.

## 5. Allocate to `--agents N`

- N unset or 2: `quality-reviewer` with no focus - the correctness lens (failure branches, races, rollout, blast radius, performance, conventions; owns `conventions`, `performance`, `reliability`) - and `security-reviewer` with focus `risk` - the risk lens (guards, money, regulated gates, and whether the change does what its title claims; also runs the `compliance-reviewer` checklist; owns `security` and `compliance`).
- N = 3: a second `quality-reviewer`, the file groups split between the two (state the split; never silently drop files). The default when `REVIEWABLE:` changed lines exceed 1500.
- N = 4: also split `risk` back into `security-reviewer` and `compliance-reviewer`.
- N < 2: refuse the reduction - run the two and say so in the report.

**Mode per reviewer, from the precheck.** The `risk` reviewer with `DOMAIN: security hits 0` and `DOMAIN: compliance hits 0` (or, split, each reviewer with zero hits in its own domain) runs in `confirm` mode: 5 tool calls to confirm no sensitive path is touched, returning `n/a` - or `escalate` with the file that is. On `escalate`, spawn that reviewer again in `full` mode. With hits, `full` mode, the `DOMAIN-HIT:` lines as starting points.

**Tool-call budget per reviewer** (the reviewer stops and reports `partial` when it runs out): `quality-reviewer` 40 (30 each when split), `risk` 30 (20 each when split), `confirm` mode 5. Budgets scale with the change: double them when `REVIEWABLE:` changed lines exceed 3000.

**Model and effort per reviewer:** every reviewer runs on Opus; the `RISK:` tier sets the effort - `low` low, `medium` medium, `high` high, `critical` xhigh. Where the runner cannot set effort per call, the session effort applies. A cheaper model misses findings a human then catches; save on effort and tool calls instead.

Spawn all reviewers in a SINGLE message (parallel). Pass each, and nothing more:

- its focus, mode, budget, and the `DIMENSION:` names it owns (§4);
- its `REVIEWABLE:` lines, copied verbatim from the precheck (pre-grouped - reviewers never re-scope; never hand-typed paths or globs);
- `quality-reviewer`: every `PRECHECK:` line; `risk`: the `DOMAIN-HIT:` lines of both domains;
- the prior findings on its files to re-verify (§2a);
- the review worktree path, the main-checkout path for its reading map, the base ref, the §2b context block, the §3b stance verbatim, and the §3c trace for its file group;
- hard caps: never open a `SKIPPED:` file; read changed files + only the callees a finding depends on; batch reads (several files in one shell call); max 10 findings; compact `[SEV] file:line - finding - evidence - fix` lines, no prose; do NOT run `/check`/tests.

## 6. Evidence gate (cut false positives)

Every reviewer applies this before returning; re-apply it yourself when synthesizing:

- Every `[BLOCK]`/`[WARN]` cites a concrete `file:line` AND the rule doc violated, or - where no rule doc covers it (§3) - the named principle plus the traced trigger. Otherwise downgrade to `[INFO]` or drop.
- High-confidence findings only; unsure = downgrade or omit. Few actionable findings beat flooding.
- No invented runtime failures - state the trigger path or don't raise it.
- Don't duplicate what tooling enforces (oxlint, the `/check` gate); for a suspected lint/boundary issue say "confirm with `pnpm check:lint`" - flag only what the gates miss.
- A `PRECHECK:` line a reviewer confirmed is evidence for its finding. One no reviewer addressed goes into the report as `[INFO] ... (precheck, unconfirmed)` - never dropped, never promoted.

## 7. Synthesize

Dedup by `file:line`, order BLOCK -> WARN -> INFO.

**Coverage gate first.** Collect one `DIMENSION:` line per dimension in §4 - from each reviewer's output, plus `rollout` and `spec` from you. A reviewer that returned no `DIMENSION:` line, or an `n/a` with no stated check, did not cover it: resume that reviewer once asking for the missing line; if it still has none, write the line as `DIMENSION: <name> - missing - <reviewer> returned no coverage` and the verdict is CHANGES REQUESTED. A `partial` line names the files the reviewer did not reach: list them in the report; `partial` on `security` or `compliance` forbids APPROVED - resume that reviewer with only the unreached files.

**Prior findings.** One `PRIOR:` line each: `fixed`, `still open`, or `obsolete` from the reviewer that re-verified it, `carried` for the rest. `still open` and `carried` findings count toward the verdict like new ones.

**Save the state** after every review, `--ci` included: write `.claude/reviews/<pr or branch>.json` in the main checkout with the reviewed HEAD SHA, base, verdict, every open finding (new, `still open`, `carried`), and the `DIMENSION:` lines.

Default and `--post`: a human-readable report - one line per finding `[SEV] file:line - finding - evidence - rule cited - fix`, one `TRACE:` line per traced entry point (format below), one status line per AC bullet, the `PRIOR:` lines, the `SKIPPED:` count, the seven `DIMENSION:` lines, and **APPROVED** / **CHANGES REQUESTED** with the most critical finding last. `--post` rewrites those findings into the §8 comments.

`--ci`: print exactly this block and nothing else - a CI job parses it line by line:

```text
FINDING: [BLOCK|WARN|INFO] <file>:<line> - <finding> - <evidence> - <rule cited> - <fix>
TRACE: <entry point> - hops <n>/7 walked - callers <checked>/<found> - <ok|BLOCK reason>
CRITERION: <acceptance criterion> - <met|not met|not verifiable>
PRIOR: [BLOCK|WARN|INFO] <file>:<line> - <finding> - <fixed|still open|obsolete|carried>
DIMENSION: <conventions|performance|reliability|security|compliance|rollout|spec> - <ran|n/a|partial|missing> - <counts per severity, what was checked for n/a, or files not reached for partial>
VERDICT: <APPROVED|CHANGES REQUESTED> - <counts per severity> - <most critical finding>
```

One `TRACE:` line per traced entry point, one `CRITERION:` line per AC bullet, exactly seven `DIMENSION:` lines, exactly one `VERDICT:` line, last. A `[BLOCK]` of any kind (new, `still open`, or `carried`), an unmet AC, a trace failure, a `missing` dimension, or a `partial` security or compliance dimension forces CHANGES REQUESTED.

Spec findings cite the ticket the way code findings cite a rule doc: a diff that crosses a ticket's out-of-scope line, answers an open question in code without recording it on the ticket, or ships behavior no AC asked for is a `[WARN]` with the ticket line quoted as evidence.

Severities: `[BLOCK]` must fix before merge (core edit, boundary break, authz/secret/PII risk, broken extension wiring, a §3c trace failure); `[WARN]` should fix (convention violation, missing test, weak validation); `[INFO]` FYI / hardening.

If `--fix`: apply BLOCK + WARN fixes in the working tree (smallest diff satisfying the cited rule), run `/check`, report green/red. Leave INFO untouched. Never commit or push.

## 8. Post to the pull request (`--post`)

Only when `--post` is set and the target is a pull-request number. Turns findings into terse review comments: one line each, brief why, backtick every identifier.

**What gets a comment.** Severity decides the verdict, not what gets posted. Every verified finding is posted unless it matches one of these, and the report names which:

- D1 the code does not do what the finding says;
- D2 a duplicate - merge it into the other;
- D3 pre-existing: the diff touches neither that path nor the order of checks around it (a new gate placed in front of an old one makes the order new);
- D4 style or naming with no written rule behind it;
- D5 a request for more test cases, when the existing tests fail without the feature;
- D6 hardening for an input that cannot reach the code - name what stops it.

Nothing else is a drop reason: not "theoretical", "unlikely", "no consumer yet", "a sibling does the same", "by design", "the lockfile pins it", or "performance only".

A finding gets its own inline comment only when a concrete trigger leads to wrong or stranded money (a debit or hold that cannot be reversed, a credit that is blocked), an authz or security bypass, a compliance gap (audit, RG, KYC, geo), data loss, a crash or 5xx, a broken public contract or declared rule (a type not exported where its siblings are, an undeclared audit action, untyped error data, a loose dependency pin), a race that persists state breaking an invariant the change adds, request-path work that grows with table size, a test that passes with the feature removed or its mock unconfigured, an unmet AC, or code that does not do what the title claims. Everything else - test gaps, naming, boundary nits, actor metadata, a weaker variant of a posted defect - joins an inline comment on the same file or becomes one line in the summary note. Merging never launders: each merged point passes the same bar on its own. A merged comment leads with its most severe finding, anchors on its line, and keeps its strongest fix. At most six inline comments.

1. **Draft.** Rewrite each finding as a terse comment keyed to its `file:line`, in the posting user's voice: when their instructions name a voice or writing guide, read it before drafting. Each comment is 1-3 sentences: what breaks, the trigger, the fix. No mechanism chain, no secondary evidence, no add-ons - the author asks if unclear. Most comments start straight with the point; soften at most one in three, never with the same opener twice in a pull request. Compose the summary as ONE sentence stating whether the changes block prod/push, e.g. `Not a blocker for push - a few cleanups worth doing.` or `Blocker: the finding in `x.ts` must be fixed before we push.` Then one short line per minor finding.
2. **Dedupe.** Read every existing thread on the pull request, resolved or not, per `docs/agents/forge.md`. Drop a draft that an existing thread already raises, even worded differently; when it adds a new fact, reply to that thread instead of opening a new one. Drop the summary when every finding was dropped.
3. **Confirm.** Show all drafted comments + the summary and stop for approval - UNLESS `--yes`, then skip straight to posting.
4. **Post inline comments** anchored to the diff, using the "Inline review comments" command in `docs/agents/forge.md`. Anchor on the NEW-file line of an added (`+`) line (`git show <src-branch>:<file> | grep -n`), and verify each response actually carries a line anchor - an unanchored fallback comment must be deleted and retried, never left behind.
5. **Post the summary** as one general comment on the pull request, per the same file, ending with the hidden marker `<!-- review:sha=<reviewed HEAD SHA> -->` so the next review on any machine can go incremental (§2a).
6. Report back the count posted + the summary verdict. Never resolve threads; never push.
7. `[oss]` findings go to the paired OSS PR instead, by `<worktree>/docs/standards/skills/review.md` "Posting to the PR", after their own confirmation. That PR is public: no operator name, no internal URL, no ticket text beyond the bare key.

## 9. Several pull requests in one run

An agent re-reads its whole context on every tool call, so a long session, or one agent walking several pull requests, costs more than short agents with one pull request each.

- Triage first, without agents: skip drafts, dependency bumps, and pull requests that change only docs, rules, or tests unless asked. Say which were skipped.
- One orchestrator and roster per pull request; never one agent over several. A single-agent review returns the full §7 block (`TRACE:`, `CRITERION:`, seven `DIMENSION:` lines); one without it is rerun, not accepted.
- Check overlap before reviewing: list each open pull request's files (`gh pr view <n> --json files` / `glab mr diff <n> --name-only`) and flag two that add a migration to the same folder or edit the same function. Each review names the other pull request and which one must rebase and regenerate.
- Before approving on the forge, read the reviewable diff yourself - at 300 lines or less that is one read. An agent's clean result is a claim, not a verdict.
- Before launching, state the agent count and a token estimate. Run batches of about three pull requests, so a usage limit stops a batch, not the run.
- Keep each agent under about 20 tool calls. Put the prompt text all agents share first and the pull-request-specific part last, so the cached prefix is reused.
- A step that only distills the ticket or merges findings runs at low effort.

## Constraints

- Reviewers report; only the orchestrator edits, and only under `--fix` (working tree only - no commit, no push).
- Never `git stash`, never `git checkout` another branch in the working tree: read MR sources with `git fetch` + `git show <sha>:<path>` / `git diff <base> <head>`. The stash stack and the worktree are shared with other sessions.
- NEVER edit `node_modules` or the main `{{ossDir}}` checkout. Under `--fix`, an `[oss]` finding is fixed in the OSS worktree only.
- Every finding cites a rule doc or a named principle with a traced trigger - no ungrounded opinions.
- Two reviewers minimum on every diff, four maximum; seven `DIMENSION:` lines on every review.
- Precheck first, reviewers second: no reviewer spends tokens on what `review-precheck` already printed.
