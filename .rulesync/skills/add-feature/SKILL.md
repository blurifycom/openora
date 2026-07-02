---
name: add-feature
description: >
  Deliver an oss platform-core feature end-to-end - the full development + delivery
  cycle: context collection -> plan + approval -> implementation -> unit/integration tests ->
  prepare e2e test cases -> e2e tests -> fixes -> create-pr -> Jira status transition -> Slack
  notice. Fed by an OSS work-order (from the consumer add-feature handoff) or an OSS ticket.
  Delegates to platform subagents, reviews, runs verify/pre-pr, opens the MR with CODEOWNERS
  reviewers. Use on "add feature", "plan <work-order>", "deliver this OSS change", or /add-feature [path|ticket].
  Read-only until the plan is approved; never pushes without explicit OK.
---

# add-feature (oss)

Platform-core twin of the consumer `add-feature` skill. Use it in the `oss` repo when a
consumer feature needs `@blurifycom/*` core changes (handed off via a work-order), or for a standalone
core feature. It owns the **whole development + delivery cycle** end to end.

## The full cycle (what this skill guarantees)

```
1 context collection (+ GRILL)  ->  2 plan + approval  ->  3 implement  ->  4 unit/integration tests
->  5 prepare e2e test cases  ->  6 e2e tests  ->  7 fix loop  ->  8 verify/regen
->  9 create-pr (push-gated)  ->  10 reviewers  ->  11 Jira transition (ONLY if user asks)  ->  12 Slack notice
```

## Coordinates

- Repo: `consumer/oss` on GitLab. MR target: `dev`. Chain `dev -> stage` + tags.
  Tool: `glab` CLI.
- Codebase inspection: `oss-dev` MCP (read-only). Headless backend - contracts + Hono + oRPC +
  Drizzle, plus the react SDK and plugins. No UI app here.
- Jira/Confluence: the **Atlassian** MCP (account-wide). cloudId `00000000-0000-0000-0000-000000000000`.
  Slack: the **Slack** MCP (account-wide).
- Slack notice channel: `the agreed notice channel` (id `C0000000000`, **draft only**).

## The contract

- **Read-only until the plan is approved.** No edits/commits/pushes/Jira writes before sign-off.
- **Never write to Jira unless the user explicitly asks for that specific write** (a transition,
  comment, worklog, or remote link). Running this skill, approving the plan, opening the MR, or
  saying "create the PR" is NOT Jira authorization. Reading the issue via the **Atlassian** MCP is always fine.
- Reuse `create-pr` (MR), `/regen`, `/pre-pr`, `/verify`. Delegate to subagents - don't
  hand-write their work.

## Steps

### 1. Resolve input + collect context (read-only)

`$ARGUMENTS` is an OSS work-order path (e.g. `~/.claude/plans/BF-XXX-oss.md`) or an OSS ticket.
Read the work-order (goal, the consumer feature it unblocks, core surface, contract/schema impact,
acceptance), then gather context in parallel:

| Source              | How                                                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Work-order / ticket | the spec from consumer, or read the issue via the **Atlassian** MCP                                                       |
| OSS docs            | `docs/` ADRs, `architecture.md`, `glossary.md`, `system-design.md`, machine-readable `docs/catalog.json` + `openapi.json` |
| Architecture rules  | `.claude/rules/clean-architecture.md`, `messaging-and-microservices.md`, `CLAUDE.md`                                      |
| Codebase            | `oss-dev` MCP + Explore - find the exact modules/contracts/seams to touch                                                 |
| Slack / Confluence  | search the BF key + title for prior design discussion                                                                     |

#### 1a. Grill the user before planning (MANDATORY)

Tickets under-specify. After the read-only context pass and BEFORE writing the plan, **grill the
user** to surface every decision that changes the build - never assume a default silently. Use
`AskUserQuestion` (batch up to 4 per call, multiple rounds) and keep going until nothing material
is unresolved. Each option leads with your recommendation + the trade-off. Cover, at minimum:

- **Scope edges** - what's explicitly in vs out; which struck-through / "later" ACs stay out.
- **Domain & seam placement** - which module owns it; which ports/tokens to bind or reuse; any
  boundary (`no-cross-domain`/`no-cross-addon`) risk in the chosen placement.
- **Data model forks** - enum expansion vs additive; history vs current-record; nullable/defaults.
- **Real-world / regulatory** - jurisdiction, gating, idempotency, audit actor/resource, retention.
- **Reuse vs build** - existing helper/port/route that already covers part of it (don't duplicate).
- **In-flight collisions** - another ticket/agent touching the same files (coordinate first).
- **Config surface** - what belongs in `platform-config` vs code; per-currency/brand granularity.

Fold every answer into the plan's "Locked decisions". A plan that hides an unasked assumption is
not ready - grilling is part of the read-only gate, not optional polish.

### 2. Plan + approval (the gate)

Present: Goal, AC, decisions-with-sources, the exact core surface (packages, contracts, Drizzle
tables, events, adapter tokens), boundary/breaking-change impact, risks, and a task breakdown
mapped to subagents. **Require explicit approval before editing.**

### 3. Implement

After approval (Task tool). Pick the implementer that fits the slice:

- `expert` - turn the work-order into concrete requirements + AC (advisory, no code).
- `module-author` - a whole new add-on (`pnpm gen module <name>`).
- `plugin-author` - an overlay extension (`/scaffold-plugin <name>`).
- `dev` - cross-module business logic, contracts, services, SDK changes.

Do NOT touch Jira here. A Jira transition happens only if the user explicitly asks for it
(see step 11).

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
- `qa` - API-level Playwright e2e against the local stack executing that checklist;
  `chrome-devtools` MCP to inspect console/network on failure.

### 7. Fix loop

Loop every review (step 5) and e2e (step 6) finding back through the step 3 implementer until
green. Re-run the affected check after each fix.

### 8. Docs + regen + verify

- `/regen` - if contracts/Drizzle changed (oRPC OpenAPI + Drizzle client + `catalog.json`).
- `docs` - only if the change touched prose docs or the agent-facing surface; it edits docs
  and runs `pnpm sync:agents`.
- `/pre-pr` (`pnpm verify` + `pnpm verify:drift`). Don't push on red or on a catalog diff.
  Optional: `operator` for an outside-in readiness check on launch-critical work.

### 9. Open the MR

Invoke `create-pr` (oss chain, target `dev`). It commits conventional, reports the SHA, **asks
for "yes push"**, pushes, and `glab mr create`s. Don't bypass the push-consent gate.

### 10. Reviewers from CODEOWNERS

Parse `oss/CODEOWNERS`, match changed globs to owners (strip `@`); set the MR description
to the plan summary + AC + the originating BF ticket KEY only (e.g. `ABC-45`, never the URL). No
internal links (Jira/Confluence/Slack), hostnames, secrets, or PII in the title/description -
see `create-pr` > "No sensitive data":

```
glab mr update <iid> --reviewer volod,klaudia.blazyczek
```

Owners: `@volod` (core/all), `@klaudia.blazyczek` (`packages/sdks/react`, `packages/ui`).

### 11. Jira status transition - ONLY on explicit user request

**Do NOT write anything to Jira by default** - no status transition, no comment, no worklog, no
remote link. Perform a Jira write ONLY when the user explicitly asks for that specific action in
their own words (e.g. "move ABC-210 to Code Review"). Running this skill, approving the plan,
opening the MR, or saying "create the PR" are NOT Jira authorization. When the user does ask:
use the **Atlassian** MCP to fetch the valid transitions, then apply the matching one.
Never post MR-link or status comments on the ticket (the user finds them noise).

### 12. Slack notice (one-line draft)

Use the **Slack** MCP to draft a message to `the agreed notice channel` - a **single line**: an emoji + the
PR/task name as a link. NOT a multi-paragraph summary. e.g. `👉 RBAC backend - MR !11`.
**Draft only**, never direct-send.

## Rules

- **Grill before you plan** (step 1a) - exhaust the material unknowns via `AskUserQuestion`; never
  bury an unasked assumption in the plan. Still read-only.
- Read-only until the plan is approved.
- Never push without an explicit per-action "yes push".
- `/pre-pr` (verify + drift) must be green before push; `/regen` after any contract/schema change.
- **Never write to Jira without an explicit user request** - no transition, comment, worklog, or
  remote link by default. Only the specific Jira write the user asks for, in their words; running
  the skill / approving the plan / opening the MR is not authorization. Never post MR-link or
  status comments.
- **Slack = one-line draft** (emoji + PR/task name), draft only, channel `the agreed notice channel`.
- One MR = one concern. Respect clean-architecture boundaries (no cross-addon imports).
