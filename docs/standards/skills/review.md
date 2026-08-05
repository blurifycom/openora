# Review workflows

## OSS review

Use for a convention-grounded review of the current change set.
Report only unless `--fix` is passed.

### Arguments

- `--agents N` selects one to six reviewers; default one reviewer per applicable dimension.
- `--base <ref>` changes the base; default `dev`.
- A PR number reviews that PR with `gh pr diff` and `gh pr view`.
- Paths limit the review scope.
- `--fix` permits the orchestrator to apply BLOCK and WARN fixes after reporting.

### Workflow

1. Scope the diff from `<base>...HEAD`, falling back to the working tree only when the branch diff is empty.
2. Group changed files by package or domain.
3. Read each changed file and the standards governing its dimension before judging it.
4. Select only dimensions that apply: contracts and boundaries, security and money, conventions and quality, messaging seams, audit completeness, and operator fit.
5. Use the matching roster reviewer where available: `contract-reviewer`, `security-reviewer`, `quality-reviewer`, or `operator`.
6. Keep unmatched dimensions in the orchestrator rather than spawning a generic agent.
7. Fan out one parallel batch, deduplicate by `file:line`, apply the evidence gate, and return one verdict.

### Evidence gate

- Every BLOCK or WARN cites a concrete `file:line`, trigger path, and rule or ADR.
- Drop uncertain, theoretical, duplicate, or tooling-only findings.
- Do not report style nits already enforced by `pnpm verify` or `pnpm check:boundaries`.
- Trace called functions whenever a finding depends on their behaviour.

### Output

- Lead with counts by severity and a verdict.
- Order findings BLOCK, WARN, INFO.
- Use `[SEV] file:line - finding - evidence - rule or ADR - fix`.
- End with APPROVED or CHANGES REQUESTED and the most critical finding.

### Fix mode

- Apply only BLOCK and WARN fixes.
- Re-run the affected verification gate.
- Never commit or push.

## Pull request review

Use for a context-aware, report-only review of the current branch or a given PR.
Return line-anchored draft comments, acceptance-criteria status, and one GO or NO-GO sentence.

### Workflow

1. Scope the diff from the supplied PR or `<base>...HEAD`, defaulting to `dev`.
2. Gather ticket acceptance criteria and unresolved PR discussion once, then distill them to a small context block.
3. Do not expose raw ticket text, internal URLs, attachments, or people's names in review output.
4. Assume each changed behaviour is broken until a concrete happy path and hostile path prove otherwise.
5. Trace empty, falsy, error, unauthorized, concurrent, and repeated inputs where applicable.
6. For a small diff, review inline from the applicable specialised-agent checklists.
7. For a larger diff, fan out only matching specialised reviewers in one parallel batch, passing the scoped files and context.
8. Deduplicate findings and discard any without a concrete location and trigger.

### Review angles

- Quality and conventions - always.
- Security and money - server, wallet, payment, auth, admin, or adapter changes.
- Contracts and boundaries - contract, schema, migration, OpenAPI, or package-entry changes.
- iGaming fit - business-rule changes with acceptance criteria.

### Output

1. Draft comments, most important first, in conversational language without internal severity markers.
2. One status line per acceptance criterion: met, not met, or not verifiable.
3. Exactly one GO or NO-GO sentence.

### Rules

- Review only - never edit, commit, push, or post comments.
- Cap review fan-out at four specialised agents.
- Money, authz, data-loss, contract-break, or unmet-acceptance findings force NO-GO.
