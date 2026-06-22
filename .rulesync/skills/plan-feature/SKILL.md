---
name: plan-feature
targets: ['claudecode']
description: >
  Deliver an igaming-oss platform-core feature end-to-end - the full development + delivery
  cycle: context collection -> plan + approval -> implementation -> unit/integration tests ->
  prepare e2e test cases -> e2e tests -> fixes -> create-pr -> Jira status transition -> Slack
  notice. Fed by an OSS work-order (from the consumer plan-feature handoff) or an OSS ticket.
  Delegates to platform subagents, reviews, runs verify/pre-pr, opens the MR with CODEOWNERS
  reviewers. Use on "plan <work-order>", "deliver this OSS change", or /plan-feature [path|ticket].
  Read-only until the plan is approved; never pushes without explicit OK.
---

# plan-feature (igaming-oss)

Platform-core twin of the consumer `plan-feature` skill. Use it in the `igaming-oss` repo when a
consumer feature needs `@blurifycom/*` core changes (handed off via a work-order), or for a standalone
core feature. It owns the **whole development + delivery cycle** end to end.

## The full cycle (what this skill guarantees)

```
1 context collection  ->  2 plan + approval  ->  3 implement  ->  4 unit/integration tests
->  5 prepare e2e test cases  ->  6 e2e tests  ->  7 fix loop  ->  8 verify/regen
->  9 create-pr (push-gated)  ->  10 reviewers  ->  11 Jira status transition  ->  12 Slack notice
```

## Coordinates

- Repo: `consumer/igaming-oss` on GitLab. MR target: `dev`. Chain `dev -> stage -> main` + tags.
  Tool: `glab` CLI.
- Codebase inspection: `oss-dev` MCP (read-only). Headless backend - contracts + Hono + oRPC +
  Drizzle, plus the react SDK and plugins. No UI app here.
- Jira/Confluence/Slack: `mcp__claude_ai_Atlassian_Rovo__*`, `mcp__claude_ai_Slack__*`
  connectors (account-wide). cloudId `00000000-0000-0000-0000-000000000000`.
- Slack notice channel: `the agreed notice channel` (id `C0000000000`, **draft only**).

## The contract

- **Read-only until the plan is approved.** No edits/commits/pushes/Jira writes before sign-off.
- Reuse `create-pr` (MR), `/regen`, `/pre-pr`, `/verify`. Delegate to subagents - don't
  hand-write their work.

## Steps

### 1. Resolve input + collect context (read-only)

`$ARGUMENTS` is an OSS work-order path (e.g. `~/.claude/plans/BF-XXX-oss.md`) or an OSS ticket.
Read the work-order (goal, the consumer feature it unblocks, core surface, contract/schema impact,
acceptance), then gather context in parallel:

| Source              | How                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Work-order / ticket | the spec from consumer, or `getJiraIssue`                                                                                 |
| OSS docs            | `docs/` ADRs, `architecture.md`, `glossary.md`, `system-design.md`, machine-readable `docs/catalog.json` + `openapi.json` |
| Architecture rules  | `.claude/rules/clean-architecture.md`, `messaging-and-microservices.md`, `CLAUDE.md`                                      |
| Codebase            | `oss-dev` MCP + Explore - find the exact modules/contracts/seams to touch                                                 |
| Slack / Confluence  | search the BF key + title for prior design discussion                                                                     |

### 2. Plan + approval (the gate)

Present: Goal, AC, decisions-with-sources, the exact core surface (packages, contracts, Drizzle
tables, events, adapter tokens), boundary/breaking-change impact, risks, and a task breakdown
mapped to subagents. **Require explicit approval before editing.**

### 3. Implement

After approval (Task tool). Pick the implementer that fits the slice:

- `igaming-expert` - turn the work-order into concrete requirements + AC (advisory, no code).
- `oss-module-author` - a whole new add-on (`pnpm gen module <name>`).
- `plugin-author` - an overlay extension (`/scaffold-plugin <name>`).
- `igaming-fullstack-dev` - cross-module business logic, contracts, services, SDK changes.

Once implementation starts, **transition the Jira ticket to In Progress** (see step 11 for the
how + the confirm gate).

### 4. Unit + integration tests

The implementer writes/updates co-located Vitest **unit and integration tests** for the slice
(service logic with a vi-mocked Drizzle; cross-module/contract behavior). These are part of the
implementation deliverable, not an afterthought - `/verify` (step 8) runs them and must be green.

### 5. Review (findings only - then fix)

Run in parallel; both report only, no edits:

- `contract-reviewer` - boundary rules, contract/schema drift, breaking changes, forbidden patterns.
- `security-reviewer` - money handling (idempotency/atomicity), authz, PII/secrets.

Address findings by looping back to the step 3 implementer. Re-review if the surface changed.

### 6. Prepare e2e test cases, then run them

- **Derive an e2e checklist from the AC first**: happy path, edge cases, authz negatives
  (401/403), money/idempotency, and the audit-trail entry for every state-changing action.
- `qa-engineer` - API-level Playwright e2e against the local stack executing that checklist;
  `chrome-devtools` MCP to inspect console/network on failure.

### 7. Fix loop

Loop every review (step 5) and e2e (step 6) finding back through the step 3 implementer until
green. Re-run the affected check after each fix.

### 8. Docs + regen + verify

- `/regen` - if contracts/Drizzle changed (oRPC OpenAPI + Drizzle client + `catalog.json`).
- `docs-sync` - only if the change touched prose docs or the agent-facing surface; it edits docs
  and runs `pnpm sync:agents`.
- `/pre-pr` (`pnpm verify` + `pnpm verify:drift`). Don't push on red or on a catalog diff.
  Optional: `igaming-operator-verifier` for an outside-in readiness check on launch-critical work.

### 9. Open the MR

Invoke `create-pr` (oss chain, target `dev`). It commits conventional, reports the SHA, **asks
for "yes push"**, pushes, and `glab mr create`s. Don't bypass the push-consent gate.

### 10. Reviewers from CODEOWNERS

Parse `igaming-oss/CODEOWNERS`, match changed globs to owners (strip `@`); set the MR description
to the plan summary + AC + the originating BF link:

```
glab mr update <iid> --reviewer volod,klaudia.blazyczek
```

Owners: `@volod` (core/all), `@klaudia.blazyczek` (`packages/sdks/react`, `packages/ui`).

### 11. Jira status transition (NOT comments)

Move the ticket along its workflow - **do NOT post MR-link or status comments on the ticket**
(the user finds them noise). Typical transitions: **In Progress** when implementation starts
(step 3), **In Review / Code Review** when the MR opens (step 9). Use
`getTransitionsForJiraIssue` to find the valid transition id, then `transitionJiraIssue`.
**Confirm with the user before each transition.**

### 12. Slack notice (one-line draft)

`slack_send_message_draft` to `the agreed notice channel` - a **single line**: an emoji + the PR/task
name as a link. NOT a multi-paragraph summary. e.g. `👉 RBAC backend - MR !11`.
**Draft only**, never direct-send.

## Rules

- Read-only until the plan is approved.
- Never push without an explicit per-action "yes push".
- `/pre-pr` (verify + drift) must be green before push; `/regen` after any contract/schema change.
- **No Jira comments** for MR/status updates - transition the ticket's status only, and confirm
  before any transition.
- **Slack = one-line draft** (emoji + PR/task name), draft only, channel `the agreed notice channel`.
- One MR = one concern. Respect clean-architecture boundaries (no cross-addon imports).
