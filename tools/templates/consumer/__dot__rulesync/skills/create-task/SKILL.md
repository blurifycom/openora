---
name: create-task

description: Create or rewrite this operator's Jira tickets in a lean, bulleted, easy-to-scan format. Use on "create task", "new ticket", "rewrite ticket", "/create-task", or any ticket-key description work.
---

# create-task

Template and clean up Jira tickets for this operator's project so they are short,
scannable, and free of filler. Use for new tasks and for rewriting bloated ones.

## Jira coordinates

- Tool: the **Atlassian** MCP - read the issue, create/edit the issue.
- `cloudId`: `<your-jira-cloud-id>`
- Project key: `<your-project-key>` (ticket keys look like `<KEY>-XXX`)
- Always pass `contentFormat: "markdown"` and `responseContentFormat: "markdown"`.

## Writing rules

- Lead with **Goal** (1-2 lines). Reader should get the point in 5 seconds.
- Everything else is **bullets**. No long prose paragraphs.
- Cut: progress logs, "we decided to instead", history, anything not actionable.
  State the current decision, not how we got there.
- Short dashes `-` only, never long dashes. ASCII only.
- Use `->` for flows, `x3` for counts, backticks for commands/env vars/paths.
- Name the owner-confirmed decisions inline with date + who (e.g. "confirmed with
  <owner> 2026-06-15") so they are not relitigated.
- Scope tightly. Push anything bigger into a separate ticket and say so in
  **Out of scope**.

## Gotchas

- **No markdown checkboxes.** `- [ ]` renders as literal `\[ \]` in Jira. Use plain
  `-` bullets for task lists and acceptance criteria.
- Markdown `##` headings and `**bold**` convert cleanly; tables convert too.
- Re-read the issue via the **Atlassian** MCP after writing only if the render looked off.

## Section template (drop unused sections)

```markdown
## Goal

<1-2 lines: what ships and for whom>

## Decisions

- <key tech/approach choice, with confirmer + date if relevant>

## Scope / What to build

- <bulleted, concrete>

## Tasks

- <ordered, each a discrete unit of work>

## Out of scope

<comma list, point to follow-up tickets>

## Acceptance criteria

- <observable, testable outcomes>
```

For infra/DevOps tickets, swap **Scope** for **Provision** (AWS services as bullets)

- **One-time bootstrap**. Link a prior infra ticket as a worked example if one exists.

## Flow

1. If rewriting: read the issue via the **Atlassian** MCP (markdown) for current state + summary.
2. Pull any missing context the ticket references (Slack decision, sibling ticket).
3. Draft against the template. Confirm scope splits with the user before creating
   new tickets.
4. Create or edit the issue via the **Atlassian** MCP. Report the ticket key + URL.
