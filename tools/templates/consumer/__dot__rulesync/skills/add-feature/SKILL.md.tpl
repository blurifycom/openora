---
name: add-feature
targets: ['*']
description: >
  Deliver a feature end-to-end in this consumer repo. Aggregates context (Jira + Confluence + Slack +
  Google Drive + Notion + local docs + past sessions + codebase), produces an approved plan, then drives
  delivery by calling sibling skills - create-plugin (build), review (review), create-pr (MR) -
  and create-task for ticket hygiene. Transitions Jira (no comments) and drafts a one-line Slack
  notice. Use on "add feature", "plan {{trackerKey}}-XXX", "deliver {{trackerKey}}-XXX", or /add-feature [{{trackerKey}}-XXX].
  Read-only until the plan is approved; never pushes, transitions Jira, or sends Slack without OK.
---

# add-feature ({{name}})

Feature-delivery orchestrator for this consumer repo: one Jira key in; a delivered MR + updated ticket + drafted Slack notice out. You orchestrate and call sibling skills - you do not re-implement their work. The platform-core twin is the `/add-feature` skill in the platform OSS repo (`{{ossDir}}/.rulesync/skills/add-feature/`).

## Coordinates

- Jira: the **Atlassian** MCP, cloudId `{{jiraCloudId}}`, project `{{trackerKey}}` (ticket keys look like `{{trackerKey}}-XXX`). Request/render content as markdown (`contentFormat` + `responseContentFormat: "markdown"`).
- Code forge: `{{gitRemotePath}}`, default target `{{mrTarget}}` - CLI and commands in `docs/agents/forge.md`.
- Slack: `{{teamChannel}}`, draft only.
- Repo: `apps/api` (Hono entry + extensions) consumes `@openora/*` upstream; UI apps, when present, sit beside it under `apps/`.
- **Hard rule:** `{{ossDir}}` (the linked OSS checkout) is read-only (guard-core hook + permission deny). Extend from the outside; core changes hand off - see `handoff.md`.

## The contract

- **Read-only until the Step 3 plan is approved.** No edits, commits, pushes, Jira writes, or Slack sends before sign-off.
- Reuse sibling skills, don't reinvent: **create-task** (ticket format), **create-plugin** (build an overlay), **review** (review), **create-pr** (MR). Delegate code to subagents.

## Steps

### 1. Resolve input + enhance the ask

`{{trackerKey}}-XXX` from `$ARGUMENTS`; if absent, ask. Echo it back. Run the `enhance-prompt` pre-step on the ask before gathering context, so Step 2 pulls only what's relevant and Step 3 plans against a clear brief.

### 2. Gather context in parallel (read-only)

Run together; skip any source that returns nothing. Read `handoff.md` only on core-change signals.

- Jira + Confluence: per `docs/agents/issue-tracker.md` - `{{trackerKey}}-XXX` whole: description, AC, every comment, every image viewed, parent epic, linked issues, and every linked Confluence page with its images and comments (`atlassian-read` for Jira + Confluence; the Atlassian MCP is for search and writes only - it returns no image bytes).
- Slack MCP: search public/private, read threads + canvases.
- Google Drive MCP: PRDs, specs.
- Notion: `ntn` CLI per `notion-memory` skill - prior decisions, lessons.
- Local docs: `{{ossDir}}/docs` (ADRs, `architecture.md`, `catalog.json`), repo READMEs, both `CLAUDE.md`.
- Past sessions: grep `~/.claude/projects/**` and `~/.claude/plans` for the ticket key.
- Codebase: `oss` MCP (read-only) + Explore - map touchpoints in `apps/*`.

### 3. Plan + classify (the gate)

Synthesize into a plan and present it. Do NOT edit yet.

- **Goal** (1-2 lines) + **Acceptance criteria** (observable, testable). AC missing or vague in Jira? Draft them yourself and mark as proposed.
- **Decisions found** - each with source (who/where/date), so they aren't relitigated.
- **Edge cases + unknowns (grill)** - per AC, enumerate: empty/error states, authz negatives, concurrency/idempotency, jurisdiction/currency variants, migration impact. Each unknown becomes either an explicit assumption in the plan or a question below - none stay silent.
- **Open questions** - ask before proceeding if any blocks design; batch them in one round, don't trickle.
- **Implementation breakdown** - tasks mapped to files/packages + the owning subagent. Classify each:
  - **downstream** -> overlay plugin / adapter swap / UI provider / config (build via `create-plugin`).
  - **OSS-core** -> only fixable in `@openora/*`. Flag it; triggers `handoff.md`.
- **Risks / dependencies** - external services, OSS handoff, data/migrations.

Require explicit approval. Treat as plan mode even if the harness isn't.

### 4. Build (delegate)

After approval, for **downstream** work: run the **create-plugin** skill for each overlay/adapter/page slice - it scaffolds, wires `extensions.config.ts`, and enforces boundaries + audit + db rules. The owning subagent (`builder`) also writes unit + integration tests as part of the deliverable. `deployer` only if infra changes; `debugger` on demand for build/runtime failures.

For **OSS-core** items: read `handoff.md`, write the work-order, STOP that slice, continue the rest. When implementation starts, transition Jira to In Progress (Step 7 - confirm first).

### 5. Tests, then review

Cheap gates first, prove it works, only then spend review on working code:

1. `/check` (typecheck + lint + unit). Don't proceed on red.
2. Derive an e2e checklist from the AC (happy path, edge cases, authz negatives, error states); `qa` writes/runs Playwright specs in `apps/e2e`, drives `chrome-devtools` on failure. E2e failures go back to `builder` BEFORE any review - don't review code that doesn't work.
3. **review** on the change set, passing what the e2e run proved so reviewers dig where tests can't reach; loop `[BLOCK]`/`[WARN]` fixes back through `builder`.
4. After fixes: re-run `/check` always; re-run the affected e2e specs if any fix changed behavior (not needed for pure convention/style fixes).

### 6. Open the MR

Run **create-pr**: it commits (`feat({{trackerKey}}-XXX): ...`), reports the SHA, asks for "yes push", pushes, and opens the pull request against `{{mrTarget}}` per `docs/agents/forge.md`, with the CODEOWNERS for the changed paths as reviewers. Never bypass its push-consent gate.

### 7. Jira status transition (NOT comments)

Use the **Atlassian** MCP - fetch the transitions -> show current status + options -> **confirm** -> apply the matching one (In Progress when build starts, In Review when the MR opens). **No MR-link or status comments.**

### 8. Draft Slack notice (one line)

Use the **Slack** MCP to draft a message to `{{teamChannel}}`: a single line - emoji + PR/task name as a link (e.g. `👉 <feature> - MR !NN`). **Draft only**, never direct-send.

## Rules

- Read-only until the Step 3 plan is approved.
- Never push without an explicit per-action "yes push" (inherited from `create-pr`).
- Never transition Jira without confirming; show status + options first. No Jira comments.
- Slack is a one-line draft, never direct-send.
- Never edit `{{ossDir}}`; hand off via `handoff.md`. Prefer overlay/plugin/adapter/config.
- One MR = one concern. Split unrelated work.
