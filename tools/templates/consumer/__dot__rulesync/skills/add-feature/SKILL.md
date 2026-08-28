---
name: add-feature

description: >
  Deliver a feature end-to-end in this consumer repo. Aggregates context (Jira + Confluence + Slack +
  Google Drive + Notion + local docs + past sessions + codebase), produces an approved plan, then drives
  delivery by calling sibling skills - create-plugin (build), review, create-pr (MR) -
  and create-task for ticket hygiene. Transitions Jira (no comments) and drafts a one-line Slack
  notice. Use on "add feature", "plan <KEY>-XXX", "deliver <KEY>-XXX", or /add-feature [<KEY>-XXX].
  Read-only until the plan is approved; never pushes, transitions Jira, or sends Slack without OK.
---

# add-feature

Feature-delivery orchestrator for this consumer repo: one Jira key in, a delivered MR +
updated ticket + drafted Slack notice out. You orchestrate and call sibling skills - you do not
re-implement their work. The platform-core twin is the `/add-feature` skill in the platform OSS repo.

## Coordinates

- Jira: the **Atlassian** MCP, cloudId `<your-jira-cloud-id>`,
  project `<your-project-key>` (ticket keys look like `<KEY>-XXX`). Pass `contentFormat` +
  `responseContentFormat: "markdown"`.
- GitLab: `<your-gitlab-project>`, MR target `dev`, `glab` CLI.
- Slack: `<your-team-channel>`, draft only.
- Repo: `apps/api` (Hono entry + extensions) consumes `@openora/*` upstream. This is a headless
  API consumer; build your frontend in its own repo and consume the API over HTTP.
- **Hard rule:** the linked OSS checkout is read-only (guard-core hook + permission deny). Extend from
  the outside; core changes hand off - see `handoff.md`.

## The contract

- **Read-only until the Step 3 plan is approved.** No edits, commits, pushes, Jira writes, or Slack
  sends before sign-off.
- Reuse sibling skills, don't reinvent: **create-task** (ticket format), **create-plugin** (build an
  overlay), **review** (review), **create-pr** (MR). Delegate code to subagents.

## Steps

### 1. Resolve input + enhance the ask

`<KEY>-XXX` from `$ARGUMENTS`; if absent, ask. Echo it back. Run the `enhance-prompt` pre-step on the ask before gathering context, so Step 2 pulls only what's relevant and Step 3 plans against a clear brief.

### 2. Gather context in parallel (read-only)

Run together; skip any source that returns nothing. Read `handoff.md` only on core-change signals.

| Source        | How                                                                                                                                                                                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ticket + wiki | per `docs/agents/issue-tracker.md`: `<KEY>-XXX` whole - description, AC, every comment, every image viewed, parent epic, linked issues, every linked wiki page with its images and comments (`atlassian-read` for Jira + Confluence; the MCP returns no image bytes) |
| Slack         | the **Slack** MCP - search public/private, read threads, read canvases                                                                                                                                                                                               |
| Google Drive  | the **Google Drive** MCP - PRDs, specs                                                                                                                                                                                                                               |
| Notion        | `ntn` CLI per `notion-memory` skill - prior decisions, lessons                                                                                                                                                                                                       |
| Local docs    | the OSS checkout's `docs` (ADRs, `architecture.md`, `catalog.json`), repo READMEs, `CLAUDE.md`                                                                                                                                                                       |
| Past sessions | grep `~/.claude/projects/**` and `~/.claude/plans` for the ticket key                                                                                                                                                                                                |
| Codebase      | `oss` MCP (read-only) + Explore - map touchpoints in `apps/api`                                                                                                                                                                                                      |

### 3. Plan + classify (the gate)

Synthesize into a plan and present it. Do NOT edit yet.

- **Goal** (1-2 lines) + **Acceptance criteria** (observable, testable).
- **Decisions found** - each with source (who/where/date), so they aren't relitigated.
- **Open questions** - ask before proceeding if any blocks design.
- **Implementation breakdown** - tasks mapped to files/packages + the owning subagent. Classify each:
  - **downstream** -> overlay plugin / adapter swap / UI provider / config (build via `create-plugin`).
  - **OSS-core** -> only fixable in `@openora/*`. Flag it; triggers `handoff.md`.
- **Risks / dependencies** - external services, OSS handoff, data/migrations.

Require explicit approval. Treat as plan mode even if the harness isn't.

### 4. Build (delegate)

After approval, for **downstream** work: run the **create-plugin** skill for each overlay/adapter/
page slice - it scaffolds, wires `extensions.config.ts`, and enforces boundaries + audit + db rules.
The owning subagent (`builder`) also writes unit + integration tests as part of the deliverable.
`deployer` only if infra changes; `debugger` on demand for build/runtime failures.

For **OSS-core** items: read `handoff.md`, write the work-order, STOP that slice, continue the rest.
When implementation starts, transition Jira to In Progress (Step 7 - confirm first).

### 5. Review + tests

- Run **review** on the change set; loop `[BLOCK]`/`[WARN]` fixes back through `builder`.
- Run `/check` (typecheck + lint). Don't proceed on red.
- Derive an e2e checklist from the AC (happy path, edge cases, authz negatives, error states), then
  `qa`: write/run the E2E specs, drive `chrome-devtools` on failure.

### 6. Open the MR

Run **create-pr**: it commits (`feat(<KEY>-XXX): ...`), reports the SHA, asks for "yes push", pushes,
and `glab mr create`s targeting `dev` with the CODEOWNERS for the changed paths as reviewers. Don't
bypass its push-consent gate.

### 7. Jira status transition (NOT comments)

Use the **Atlassian** MCP - fetch the transitions -> show current status + options -> **confirm** ->
apply the matching one (In Progress when build starts, In Review when the MR opens). **No MR-link or status comments.**

### 8. Draft Slack notice (one line)

Use the **Slack** MCP to draft a message to `<your-team-channel>`: a single line - emoji + PR/task name
as a link (e.g. `👉 <feature> - MR !NN`). **Draft only**, never direct-send.

## Rules

- Read-only until the Step 3 plan is approved.
- Never push without an explicit per-action "yes push" (inherited from `create-pr`).
- Never transition Jira without confirming; show status + options first. No Jira comments.
- Slack is a one-line draft, never direct-send.
- Never edit the linked OSS checkout; hand off via `handoff.md`. Prefer overlay/plugin/adapter/config.
- One MR = one concern. Split unrelated work.
