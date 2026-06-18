---
name: plan-feature
targets: ['claudecode']
description: >
  Deliver an igaming-oss platform-core feature end-to-end. Fed by an OSS work-order (from the
  consumer plan-feature handoff) or an OSS ticket. Aggregates context from docs/ADRs/catalog +
  Jira + Confluence + Slack + the codebase, produces an approved plan, delegates to platform
  subagents, reviews, runs verify/pre-pr, opens the MR with CODEOWNERS reviewers, and reports
  back. Use on "plan <work-order>", "deliver this OSS change", or /plan-feature [path|ticket].
  Read-only until the plan is approved; never pushes without explicit OK.
---

# plan-feature (igaming-oss)

Platform-core twin of the consumer `plan-feature` skill. Use it in the `igaming-oss` repo when a
consumer feature needs `@oss/*` core changes (handed off via a work-order), or for a standalone
core feature.

## Coordinates

- Repo: `consumer/igaming-oss` on GitLab. MR target: `dev`. Chain `dev -> stage -> main` + tags.
  Tool: `glab` CLI.
- Codebase inspection: `oss-dev` MCP (read-only). Headless backend - contracts + Hono + oRPC +
  Drizzle, plus the react SDK and plugins. No UI app here.
- Jira/Confluence/Slack: `mcp__claude_ai_Atlassian_Rovo__*`, `mcp__claude_ai_Slack__*`
  connectors (account-wide). cloudId `00000000-0000-0000-0000-000000000000`.
- Slack notice channel: `the agreed notice channel` (draft only).

## The contract

- **Read-only until the plan is approved.** No edits/commits/pushes/Jira writes before sign-off.
- Reuse `create-pr` (MR), `/regen`, `/pre-pr`, `/verify`. Delegate to subagents - don't
  hand-write their work.

## Steps

### 1. Resolve input

`$ARGUMENTS` is an OSS work-order path (e.g. `~/.claude/plans/BF-XXX-oss.md`) or an OSS ticket.
Read the work-order: goal, the consumer feature it unblocks, core surface, contract/schema
impact, acceptance. Echo what you'll deliver.

### 2. Gather context in parallel (read-only)

| Source              | How                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Work-order / ticket | the spec from consumer, or `getJiraIssue`                                                                                  |
| OSS docs            | `docs/` ADRs, `architecture.md`, `glossary.md`, `system-design.md`, machine-readable `docs/catalog.json` + `openapi.json` |
| Architecture rules  | `.claude/rules/clean-architecture.md`, `messaging-and-microservices.md`, `CLAUDE.md`                                      |
| Codebase            | `oss-dev` MCP + Explore - find the exact modules/contracts/seams to touch                                                 |
| Slack / Confluence  | search the BF key + title for prior design discussion                                                                     |

### 3. Plan + approval (the gate)

Present: Goal, AC, decisions-with-sources, the exact core surface (packages, contracts, Drizzle
tables, events, adapter tokens), boundary/breaking-change impact, risks, and a task breakdown
mapped to subagents. Require explicit approval before editing.

### 4. Implement

After approval (Task tool). Pick the implementer that fits the slice:

- `igaming-expert` - turn the work-order into concrete requirements + AC (advisory, no code).
- `oss-module-author` - a whole new add-on (`pnpm gen module <name>`).
- `plugin-author` - an overlay extension (`/scaffold-plugin <name>`).
- `igaming-fullstack-dev` - cross-module business logic, contracts, services, SDK changes.

### 5. Review (findings only - then fix)

Run in parallel before the gate; both report only, no edits:

- `contract-reviewer` - boundary rules, contract/schema drift, breaking changes, forbidden patterns.
- `security-reviewer` - money handling (idempotency/atomicity), authz, PII/secrets.

Address findings by looping back to the Step 4 implementer. Re-review if the surface changed.

### 6. Test

- `qa-engineer` - API-level Playwright e2e against the local stack; `chrome-devtools` MCP to
  inspect console/network on failure. Loop fixes through the implementer until green.

### 7. Docs + regen

- `docs-sync` - only if the change touched prose docs or the agent-facing surface (framework,
  ports, modules, examples). It edits docs and runs `pnpm sync:agents`.
- `/regen` - if contracts/Drizzle changed (oRPC OpenAPI + Drizzle client + `catalog.json`).

### 8. Verify

Run `/pre-pr` (`pnpm verify` + `pnpm verify:drift`). Don't push on red or on a catalog diff.
Optional: `igaming-operator-verifier` for an outside-in readiness check on launch-critical work.

### 9. Open the MR

Invoke `create-pr` (oss chain, target `dev`). It commits conventional, reports the SHA, **asks
for "yes push"**, pushes, and `glab mr create`s. Don't bypass the push-consent gate.

### 10. Reviewers from CODEOWNERS

Parse `igaming-oss/CODEOWNERS`, match changed globs to owners (strip `@`):

```
glab mr update <iid> --reviewer volod,klaudia.blazyczek
```

Owners: `@volod` (core/all), `@klaudia.blazyczek` (`packages/sdks/react`, `packages/ui`). Set
the MR description to the plan summary + AC + the originating BF link.

### 11. Report back

- Comment the oss MR URL on the originating BF Jira ticket so consumer can unblock its MR once
  this merges and a new `@oss/*` version is published.
- `slack_send_message_draft` to `the agreed notice channel`: one-line summary + MR URL + reviewers.
  Draft only.

## Rules

- Read-only until the plan is approved.
- Never push without an explicit per-action "yes push".
- `/pre-pr` (verify + drift) must be green before push; `/regen` after any contract/schema change.
- Slack draft only; confirm before any Jira transition.
- One MR = one concern. Respect clean-architecture boundaries (no cross-addon imports).
