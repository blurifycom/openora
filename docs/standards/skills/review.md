# Review workflow

One skill, `/review`, for a context-aware, convention-grounded review of the current branch or a given PR.
Report only unless `--fix` or `--post` is passed.

## Arguments

- `--base <ref>` changes the base; default `dev`.
- A PR number reviews that PR with `gh pr diff` and `gh pr view`.
- Paths limit the review scope.
- `--agents N` selects one to four reviewers; default two (step 6). N = 1 folds everything into `quality-reviewer` except security and money, which the orchestrator runs itself. N = 3 gives contracts and boundaries back to `contract-reviewer`, or adds `operator` when the ticket has acceptance criteria. N = 4 adds a second `quality-reviewer` split by file group, and the report states the split.
- `--fix` applies BLOCK and WARN fixes in the working tree after the report.
- `--post` publishes the findings to the PR; it needs a PR number.
- `--yes` skips the confirmation before posting.
- `--ci` runs without questions: never ask, never post, never fix; print only the machine-readable block below. The model cannot set the process exit code; the CI job derives it from the last line, for example `claude -p '/review --ci' | tee review.txt | grep -q '^VERDICT: GO'`.

## Workflow

1. Scope the diff from the supplied PR or `<base>...HEAD`, falling back to the working tree only when the branch diff is empty. Under `--ci` an empty diff is a GO with zero findings; otherwise ask.
2. Gather the spec once, per `docs/agents/issue-tracker.md`: resolve the ticket from the PR body, title, branch, or commit subjects and read it whole - description, acceptance criteria, every comment, every attached image viewed (not listed), linked spec pages with their own images and comments, and a referenced chat thread only when the criteria depend on it. Add the unresolved PR discussion. Distill to a context block of at most 40 lines: goal, criteria quoted verbatim, decisions from comments, design references, out-of-scope lines. No ticket resolves: state `no ticket` and review against the PR description. The fetch fails: state `no access`. Never infer criteria silently. The PR description is the author's claim, not the spec; a contradiction between it, the ticket, and the diff is a finding. Do not expose raw ticket text, internal URLs, attachments, or people's names in review output.
3. Group changed files by package or domain, and read each changed file and the standard governing its dimension before judging it.
4. Assume each changed behaviour is broken until a concrete happy path and hostile path prove otherwise. Trace empty, falsy, error, unauthorized, concurrent, and repeated inputs.
5. Run the request trace for each changed entry point and check the blast radius.
6. Split reviewers by what they read, never by checklist: an agent's cost is its tool calls times its context, and two reviewers on the same files pay for them twice. Default roster, two lenses: `security-reviewer` owns the risk lens (security, money, compliance, and whether the change does what its title claims) and also works `contract-reviewer`'s checklist, since both read the same public surface; `quality-reviewer` owns the correctness lens (failure branches, races, rollout, blast radius, performance, tests, conventions). `operator` joins only with acceptance criteria. Keep an unmatched dimension in the orchestrator; never spawn a generic agent.
7. Rate the risk from the changed paths, never from the title or the line count: `critical` for money, wallet, KYC, RG, geo, or audit; `high` for any schema, migration, contract, router, service, plugin, or job; `medium` for client logic; `low` for components, styles, or copy. Raise the tier after reading the diff when the content warrants it, never lower it below the path rule. Every reviewer runs on Opus at the matching effort (`low`, `medium`, `high`, `xhigh`). Spawn both reviewers in one message whatever the diff size, passing each the scoped files, the context block, and the caller list for its file group; one reviewer working every checklist finds about half of what two lens reviewers find.
8. Deduplicate by `file:line`, apply the evidence gate, and return one verdict.

## Request trace

Use for every change that crosses a layer: a route, a service, a query, a table, an event, or a job.
Skip only for a change that stays inside one pure function, a test, a doc, or a type.
Money, wallet, ledger, payment, auth, authz, KYC, and RG paths always get a trace.

### Walk the hops

For each changed route or entry point, list the hops in order and open the code at each one. Do not stop at the diff hunk.

1. Contract - the input schema is the only input; every field the handler reads is declared and validated.
2. Handler - guards run first; the tenant, player, or actor id comes from the session, never from the body.
3. Service - each callee is opened, not assumed; typed failures return, unexpected errors do not leak.
4. Query - every read and write filters by tenant or owner; the write and its ledger row and audit row share one transaction.
5. Table - the invariant lives in a constraint, index, or foreign key, not only in code; a migration exists for every schema change.
6. Side effects - an event, job, or outbox message is emitted after commit, and its handler is safe to run twice.
7. Response - the output matches the contract schema and leaks no extra field; each error path returns the code the client expects.

### Check the blast radius

The change must not break a part it does not name. Build the caller list with `git grep -w -- <symbol> -- '*.ts' '*.tsx' '*.sql'` for each changed export, table symbol, and SQL table name, then confirm each use still holds.

- A changed table, column, enum, or constraint: every query, migration, seed, and schema export that touches it.
- A changed query or repository function: every caller, traced through hops 4 to 7.
- A changed service function: every caller, including jobs, event handlers, and other modules.
- A changed contract or shared type: every consumer, including the react surface and the MCP tools.
- A changed event or job payload: every handler, and that it accepts both the old and the new shape during rollout.

Use `docs/catalog.json` or the `oss-dev` MCP tools to list the users of a table, route, or event before grepping.

### Check the migration

For each changed migration, run `pnpm check:drift` and read the generated SQL.

- A `DROP`, a `RENAME`, or a column type change breaks the instances still running the previous release; it is a BLOCK in the same PR as the reader change. It ships in a later release, after every reader of the old shape is deployed.
- A new `NOT NULL` column without a default fails on existing rows; it is a BLOCK.
- Expand first, contract later: add the new shape, migrate readers, then remove the old shape in a later release.
- A hand-edited migration is a BLOCK; regenerate it with `pnpm regen`.

### Prove with tests

The orchestrator may run the tests of a touched module, never the full gate.

- For each caller found in the blast radius, run the tests that import it, in the workspace that owns them: unit `pnpm -F @openora/core exec vitest related <path> --run`; integration `pnpm -F @openora/core exec vitest related <path> --run --config vitest.integration.config.ts`; E2E `pnpm -F @openora/testing exec vitest related <path> --run`.
- A failing test is a BLOCK with the test name as evidence.
- A caller with no test is an INFO, not a request to write one.
- Tests that could not run (no install in the review worktree) are reported as `TESTS: not run - <reason>`, never skipped silently, and forbid a GO on `high` or `critical` risk.

### Report the trace

- One `TRACE:` line per entry point, so the reader can see what the trace covered.
- A missing hop, an unfiltered query, a write outside the transaction, a caller that no longer holds, or an unsafe migration is a BLOCK.
- A hop that could not be traced is a finding, not a silent pass.

### Paired consumer change

A consumer that builds on this repo may pair a PR here with a change of its own (same branch name). The consumer-side review covers both diffs and the contract between them. Here, judge the public surface: a changed export, route, event payload, or config field that breaks existing consumers is a BLOCK unless the PR's Risks section states the migration. Judge genericity too: core that encodes one operator's behavior (a jurisdiction rule, a vendor, a limit or flow only one operator needs) instead of a seam other operators can bind is a BLOCK.

## Evidence gate

- Every BLOCK or WARN cites a concrete `file:line`, trigger path, and rule or ADR.
- Drop uncertain, duplicate, or tooling-only findings, and any without a concrete trigger. A rare trigger is still a trigger.
- Do not report style nits already enforced by `pnpm verify` or `pnpm check:boundaries`.
- Trace called functions whenever a finding depends on their behaviour.

### What gets a comment

Every verified finding is posted unless it matches one of these, and the report names which:

- D1 the code does not do what the finding says;
- D2 a duplicate - merge it into the other;
- D3 pre-existing: the diff touches neither that path nor the order of checks around it (a new gate placed in front of an old one makes the order new);
- D4 style or naming with no written rule behind it;
- D5 a request for more test cases, when the existing tests fail without the feature;
- D6 hardening for an input that cannot reach the code - name what stops it.

Nothing else is a drop reason: not "theoretical", "unlikely", "no consumer yet", "a sibling does the same", "by design", "the lockfile pins it", or "performance only".

A finding gets its own inline comment only when a concrete trigger leads to wrong or stranded money (a debit or hold that cannot be reversed, a credit that is blocked), an authz or security bypass, a compliance gap (audit, RG, KYC), data loss, a crash or 5xx, a broken public contract or declared rule (a type not exported where its siblings are, an undeclared audit action, untyped error data, a loose dependency pin), a race that persists state breaking an invariant the PR adds, request-path work that grows with table size, a test that passes with the feature removed or its mock unconfigured, or code that does not do what the title claims. Everything else - test gaps, naming, boundary nits, actor metadata, a weaker variant of a posted defect - joins an inline comment on the same file or becomes one line in the summary note. Merging never launders: each merged point passes the same bar on its own. A merged comment leads with its most severe finding, anchors on its line, and keeps its strongest fix. At most six inline comments.

## Output

Default and `--post`: a human-readable report, and the same drafts are what `--post` publishes.

1. Draft comments per "What gets a comment", most important first, in conversational language without severity markers; each names its `file:line`.
2. One `TRACE:` line per traced entry point, as below.
3. One status line per acceptance criterion: met, not met, or not verifiable. A UI criterion backed by a design screenshot is met only after comparing the rendered UI against it. A diff that crosses the ticket's out-of-scope line, or decides an open question in code without recording it on the ticket, is a draft comment citing that line.
4. Exactly one GO or NO-GO sentence, last.

`--ci`: print exactly this block and nothing else; a CI job parses it line by line.

```text
FINDING: [BLOCK|WARN|INFO] <file>:<line> - <finding> - <evidence> - <rule or ADR> - <fix>
TRACE: <entry point> - hops <n>/7 walked - callers <checked>/<found> - <ok|BLOCK reason>
CRITERION: <acceptance criterion> - <met|not met|not verifiable>
VERDICT: <GO|NO-GO> - <counts by severity> - <most critical finding>
```

- Order findings BLOCK, WARN, INFO; exactly one `VERDICT:` line, last.
- In both forms, money, authz, data-loss, contract-break, unmet-acceptance, or trace BLOCK findings force NO-GO.

## Posting to the PR

Report only by default. `--post` publishes the findings to the PR; it needs a PR number.

1. Read every existing review thread and comment on the PR (`gh api "repos/blurifycom/openora/pulls/<n>/comments"` and `.../issues/<n>/comments`). Drop a draft an existing comment already raises, even worded differently; when it adds a new fact, reply in that thread instead. Post nothing when every draft was dropped.
2. Show the exact comment bodies and their anchors, then stop for confirmation. `--yes` skips that stop.
3. Post inline with `gh api "repos/blurifycom/openora/pulls/<n>/comments"`, one per finding, anchored to `path` and `line` on the head commit.
4. Post the GO or NO-GO line as a single summary review.
5. Write every comment in the user's voice: when their instructions name a voice or writing guide, read it before drafting. Plain, direct, no severity markers, no internal ticket text or names. Each comment is 1-3 sentences: what breaks, the trigger, the fix. No mechanism chain, no secondary evidence, no add-ons - the author asks if unclear. Most comments start straight with the point; soften at most one in three, never with the same opener twice in a pull request.

## Fix mode

- Apply only BLOCK and WARN fixes, the smallest diff that satisfies the cited rule.
- Re-run the affected verification gate.
- Never commit or push.

## Rules

- Never edit, commit, or push outside `--fix`, and never commit or push under it.
- Cap review fan-out at four specialised agents.
- Several PRs in one run: triage first without agents (skip drafts, dependency bumps, and docs-, rules-, or test-only PRs unless asked, and say which were skipped); one orchestrator per PR, never one agent over several; state the agent count and a token estimate before launching; run batches of about three PRs; keep each agent under about 20 tool calls, with the prompt text all agents share first and the PR-specific part last. Before reviewing, list each open PR's files and flag two that add a migration to the same folder or edit the same function; each review names the other PR and which one must rebase. Approve on the forge only after reading the reviewable diff yourself - an agent's clean result is a claim, not a verdict.
- Every finding cites a rule doc or ADR; no ungrounded opinions.
