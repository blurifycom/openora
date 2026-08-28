# Review workflow

One skill, `/review`, for a context-aware, convention-grounded review of the current branch or a given PR.
Report only unless `--fix` or `--post` is passed.

## Arguments

- `--base <ref>` changes the base; default `dev`.
- A PR number reviews that PR with `gh pr diff` and `gh pr view`.
- Paths limit the review scope.
- `--agents N` selects one to four reviewers; default one reviewer per applicable dimension.
- `--fix` applies BLOCK and WARN fixes in the working tree after the report.
- `--post` publishes the findings to the PR; it needs a PR number.
- `--yes` skips the confirmation before posting.
- `--ci` runs without questions: never ask, never post, never fix; print the report and exit `1` on NO-GO, `0` on GO.

## Workflow

1. Scope the diff from the supplied PR or `<base>...HEAD`, falling back to the working tree only when the branch diff is empty. Under `--ci` an empty diff is a GO with zero findings; otherwise ask.
2. Gather ticket acceptance criteria and unresolved PR discussion once, then distill them to a context block of at most 30 lines. Do not expose raw ticket text, internal URLs, attachments, or people's names in review output.
3. Run `pnpm review:blast-radius --base <ref>` and keep its output; it is the input for the request trace.
4. Group changed files by package or domain, and read each changed file and the standard governing its dimension before judging it.
5. Assume each changed behaviour is broken until a concrete happy path and hostile path prove otherwise. Trace empty, falsy, error, unauthorized, concurrent, and repeated inputs.
6. Run the request trace for each changed entry point and check the blast radius.
7. Select only dimensions that apply and the roster reviewer that owns each: contracts and boundaries (`contract-reviewer`), security and money (`security-reviewer`), conventions and quality (`quality-reviewer`, always), operator fit (`operator`, only with acceptance criteria). Keep an unmatched dimension in the orchestrator; never spawn a generic agent.
8. For a diff of at most 150 changed lines, review inline from the reviewer checklists. For a larger diff, fan out one parallel batch, passing each reviewer the scoped files, the context block, and the blast-radius output for its file group.
9. Deduplicate by `file:line`, apply the evidence gate, and return one verdict.

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

The change must not break a part it does not name. Start from the `review:blast-radius` output, then confirm each use still holds.

- A changed table, column, enum, or constraint: every query, migration, seed, and schema export that touches it.
- A changed query or repository function: every caller, traced through hops 4 to 7.
- A changed service function: every caller, including jobs, event handlers, and other modules.
- A changed contract or shared type: every consumer, including the react surface and the MCP tools.
- A changed event or job payload: every handler, and that it accepts both the old and the new shape during rollout.

Use `docs/catalog.json` or the `oss-dev` MCP tools to list the users of a table, route, or event before grepping.

### Check the migration

For each changed migration, run `pnpm check:drift` and read the generated SQL. The script marks the statements to check.

- A `DROP`, a `RENAME`, or a column type change breaks the code still deployed; it is a BLOCK unless the code that reads the old shape is already gone.
- A new `NOT NULL` column without a default fails on existing rows; it is a BLOCK.
- Expand first, contract later: add the new shape, migrate readers, then remove the old shape in a later release.
- A hand-edited migration is a BLOCK; regenerate it with `pnpm regen`.

### Prove with tests

The orchestrator may run the tests of a touched module, never the full gate.

- For each caller found in the blast radius, run its existing test: `pnpm -F @openora/core vitest related <path>`.
- A failing test is a BLOCK with the test name as evidence.
- A caller with no test is an INFO, not a request to write one.

### Report the trace

- One `TRACE:` line per entry point, so the reader can see what the trace covered.
- A missing hop, an unfiltered query, a write outside the transaction, a caller that no longer holds, or an unsafe migration is a BLOCK.
- A hop that could not be traced is a finding, not a silent pass.

## Evidence gate

- Every BLOCK or WARN cites a concrete `file:line`, trigger path, and rule or ADR.
- Drop uncertain, theoretical, duplicate, or tooling-only findings.
- Do not report style nits already enforced by `pnpm verify` or `pnpm check:boundaries`.
- Trace called functions whenever a finding depends on their behaviour.

## Output

Print exactly this block; a CI job parses it line by line.

```text
FINDING: [BLOCK|WARN|INFO] <file>:<line> - <finding> - <evidence> - <rule or ADR> - <fix>
TRACE: <entry point> - hops <n>/7 walked - callers <checked>/<found> - <ok|BLOCK reason>
CRITERION: <acceptance criterion> - <met|not met|not verifiable>
VERDICT: <GO|NO-GO> - <counts by severity> - <most critical finding>
```

- Order findings BLOCK, WARN, INFO.
- One `TRACE:` line per traced entry point; one `CRITERION:` line per acceptance criterion.
- Exactly one `VERDICT:` line, last.
- Money, authz, data-loss, contract-break, unmet-acceptance, or trace BLOCK findings force NO-GO.

## Posting to the PR

Report only by default. `--post` publishes the findings to the PR; it needs a PR number.

1. Show the exact comment bodies and their anchors, then stop for confirmation. `--yes` skips that stop.
2. Post inline with `gh api "repos/blurifycom/openora/pulls/<n>/comments"`, one per finding, anchored to `path` and `line` on the head commit.
3. Post the GO or NO-GO line as a single summary review.
4. Write every comment in the user's voice: plain, direct, no severity markers, no internal ticket text or names.

## Fix mode

- Apply only BLOCK and WARN fixes, the smallest diff that satisfies the cited rule.
- Re-run the affected verification gate.
- Never commit or push.

## Rules

- Never edit, commit, or push outside `--fix`, and never commit or push under it.
- Cap review fan-out at four specialised agents.
- Every finding cites a rule doc or ADR; no ungrounded opinions.
