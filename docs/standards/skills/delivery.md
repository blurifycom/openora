# Delivery workflows

## Add feature

Use for an OSS platform-core feature, a consumer work-order requiring `@openora/*` changes, or a standalone core feature.
Read-only until the plan is explicitly approved.

### Workflow

1. Resolve the input and collect scoped context from the ticket, relevant ADRs, generated contract surfaces, matching standards, source, and prior design discussion.
2. Run prompt enhancement before gathering deeply so the work remains scoped.
3. Grill every design choice that would change the build: scope, domain and seam ownership, data-model forks, regulatory and audit requirements, reuse, in-flight collisions, and config surface.
4. Present goal, acceptance criteria, locked decisions with sources, exact surface, boundary impact, risks, and a task breakdown mapped to roster agents.
5. Require explicit approval before editing.
6. Delegate implementation by slice: `expert` for requirements, `module-author` for a new module, `plugin-author` for an overlay, and `dev` for cross-module logic, contracts, services, or SDK work.
7. Ship co-located unit and integration tests with each slice.
8. Derive and run E2E cases from the acceptance criteria, including authz negatives, money/idempotency, and audit entries for mutations.
9. Send E2E and review findings back to the implementer until green.
10. Regenerate after contract or Drizzle changes, run the full verification gate, then invoke the pull-request workflow.

### Delivery rules

- Never write to Jira unless the user explicitly requests that exact write.
- Draft Slack notices only, and only after delivery.
- One PR per concern.
- Never push without explicit per-action confirmation.

## Create pull request

Use `gh` against `github.com/blurifycom/openora`.
Promotion follows `feature -> dev -> stage -> tag`.

### Target selection

- `dev` targets `stage`.
- `stage` is released by an explicitly requested tag, not a PR.
- `feat/*`, `fix/*`, and every other feature branch target `dev`.

### Workflow

1. Determine the current branch and target.
2. Inspect `git status -s` and stage only this work's files.
3. Leave foreign or pre-existing edits untouched and report them.
4. Create a lowercase conventional commit without AI trailers or sensitive data.
5. Run `pnpm verify`.
6. Report the commit SHA and stop for explicit per-action push confirmation.
7. Push only after that confirmation.
8. Reuse an existing matching PR if present; otherwise read `.github/pull_request_template.md`, complete its actual sections, then create the PR with `gh`.
9. Report the PR URL.

### Public-record rules

- Do not put internal URLs, secrets, tokens, customer or operator names, PII, internal hosts, or paths in commit messages, PR titles, or PR descriptions.
- Refer to tickets by bare key only.
