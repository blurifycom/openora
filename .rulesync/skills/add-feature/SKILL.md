---
name: add-feature
description: >
  Deliver an OSS platform-core feature end-to-end: context collection -> plan + approval ->
  implementation -> unit/integration tests -> e2e test cases + run -> fixes -> create-pr ->
  Jira transition (only on explicit ask) -> Slack notice. Fed by a work-order (from the consumer
  add-feature handoff) or an OSS ticket. Use on "add feature", "plan <work-order>", "deliver this
  OSS change", or /add-feature [path|ticket]. Read-only until the plan is approved; never pushes
  without explicit OK.
---

# add-feature (oss)

Platform-core twin of the consumer `add-feature` skill. Use in this repo when a consumer feature needs `@openora/*` core changes (via a work-order) or for a standalone core feature. Owns the whole development + delivery cycle.

```
1 context (+ GRILL) -> 2 plan + approval -> 3 implement -> 4 unit/integration tests
-> 5 review -> 6 e2e cases + run -> 7 fix loop -> 8 regen/verify -> 9 create-pr
-> 10 reviewers -> 11 Jira (ONLY if asked) -> 12 Slack draft
```

## Coordinates

- Repo: `github.com/blurifycom/openora`. PR target: `dev` (chain `dev -> stage` + tags). Tool: `gh` CLI.
- Codebase inspection: `oss-dev` MCP (read-only). Headless backend - contracts + Hono + oRPC + Drizzle + react SDK + plugins. No UI here.
- Issue tracker / chat: use whatever MCP integrations the session has (Jira/Confluence, Slack). Chat notices are **draft only**, to the team's agreed channel. No integration connected: skip those steps silently.

## The contract

- **Read-only until the plan is approved.** No edits/commits/pushes/Jira writes before sign-off.
- **Never write to Jira unless the user explicitly asks for that specific write.** Approving the plan or opening the PR is NOT Jira authorization. Reading is always fine.
- Reuse `create-pr`, `/regen`, `/pre-pr`, `/verify`. Delegate to the roster subagents - don't hand-write their work.

## Steps

### 1. Resolve input + collect context (read-only)

`$ARGUMENTS` is a work-order path (eg `~/.claude/plans/<ticket>-oss.md`) or a ticket. Read it (goal, consumer feature it unblocks, core surface, contract/schema impact, acceptance), then gather in parallel: the ticket (tracker MCP if connected), `docs/` ADRs + `catalog.json` + `openapi.json`, the rule docs (`conventions`, `clean-architecture`, `messaging-and-microservices`, `db-conventions`), the codebase (`oss-dev` MCP + Explore), chat/wiki for prior design discussion (search the ticket key). Run the `enhance-prompt` pre-step on the ask first, so this gather stays scoped and 1a grills against a clear brief.

#### 1a. Grill the user before planning (MANDATORY)

Tickets under-specify. Before writing the plan, surface every decision that changes the build via `AskUserQuestion` (batch up to 4, multiple rounds) - never assume a default silently. Each option leads with your recommendation + trade-off. Cover at minimum: scope edges (in vs out), domain + seam placement (which module owns it; boundary risk), data-model forks (enum vs additive, history vs current, nullable/defaults), regulatory angle (jurisdiction, gating, idempotency, audit actor/resource), reuse vs build (existing helper/port/route), in-flight collisions, config surface (`platform-config` vs code). Fold answers into the plan's "Locked decisions".

### 2. Plan + approval (the gate)

Present: goal, AC, locked decisions with sources, exact core surface (packages, contracts, tables, events, adapter tokens), boundary/breaking-change impact, risks, task breakdown mapped to subagents. **Require explicit approval before editing.**

### 3. Implement

Pick the implementer per slice: `expert` (fuzzy -> requirements, advisory), `module-author` (new module), `plugin-author` (overlay), `dev` (cross-module logic, contracts, services, SDK).

### 4. Unit + integration tests

The implementer ships co-located Vitest tests with the slice (`createTestDb` against real Postgres for services; `bootTestApp` for integration) - part of the deliverable, not an afterthought.

### 5. E2E

Derive the checklist from the AC first: happy path, edge cases, authz negatives (401/403), money/idempotency, audit entry per mutation. Then `qa` executes it API-level. E2e failures go back to the step-3 implementer BEFORE any review - don't review code that doesn't work.

### 6. Review (findings only)

In parallel: `contract-reviewer` (boundaries, contract/schema drift, breaking changes) + `security-reviewer` (money, authz, PII) + `quality-reviewer` (performance, duplication, simplification, conventions). Pass each what the e2e run proved so reviewers dig where tests can't reach. Loop findings back to the implementer; re-review if the surface changed, and re-run the affected e2e checks if a fix changed behavior.

### 7. Fix loop

Every review/e2e finding goes back through the step-3 implementer until green; re-run the affected check after each fix.

### 8. Regen + verify

`/regen` if contracts/Drizzle changed; `docs` agent only if prose docs / agent surface changed; `/pre-pr` (`pnpm verify` + `pnpm check:drift`). Don't proceed on red or a catalog diff.

### 9. Open the PR

Invoke `create-pr` (target `dev`). It commits conventional, reports the SHA, **asks for "yes push"**, then pushes and opens the PR. Never bypass the push-consent gate.

### 10. Reviewers from CODEOWNERS

Match changed paths against `CODEOWNERS`, then `gh pr edit <num> --add-reviewer <owners>`. PR description = plan summary + AC + bare ticket key (`ABC-45`, never a URL). No internal links/hostnames/secrets/PII.

### 11. Jira - ONLY on explicit user request

No transition, comment, worklog, or link by default. When the user asks in their own words (eg "move ABC-210 to Code Review"): fetch valid transitions via the tracker MCP, apply the matching one. Never post PR-link/status comments on the ticket.

### 12. Slack notice

Draft (never direct-send) a **single line** to the team's agreed notice channel: emoji + PR/task name as a link, eg `👉 RBAC backend - PR #11`.

## Rules

- Grill before you plan; read-only until approval; never push without a per-action "yes push".
- `/pre-pr` green before push; `/regen` after any contract/schema change.
- One PR = one concern; respect boundaries (no cross-module imports).
