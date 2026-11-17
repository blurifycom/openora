---
name: create-task
targets: ['*']
description: Create or rewrite this operator's Jira tickets in a lean, bulleted, easy-to-scan format, from a wiki spec page, a design prototype, or plain notes. Use on "create task", "new ticket", "rewrite ticket", "turn this into Jira issues", "break this feature down in Jira", "/create-task", or any {{trackerKey}}-XXX description work.
---

# create-task ({{name}})

Template and clean up Jira tickets for this operator's project so they are short, scannable, and free of filler. Use for new tasks, for breaking a spec or design into issues, and for rewriting bloated ones.

## Jira coordinates

- Tool: the **Atlassian** MCP - read the issue, create/edit the issue.
- `cloudId`: `{{jiraCloudId}}` (`{{jiraSite}}`)
- Project key: `{{trackerKey}}` (ticket keys look like `{{trackerKey}}-XXX`)
- Always pass `contentFormat: "markdown"` and `responseContentFormat: "markdown"`, except for checkable acceptance criteria (see gotchas).
- Epic link: the standard `parent` field (`parent: { key: "<EPIC-KEY>" }`), not the deprecated Epic Link custom field.

## Issue type

| Type | When |
| --- | --- |
| Epic | One per module spec page. Description empty. Confirm with the user before creating one. |
| Story | One per sub-feature, or per distinct flow or command inside it. The common case. |
| Task | Small freestanding work: bugfix, config change, provider swap, spike. Also a shipped feature that drifted from its design. |

No sub-tasks, sprints, or test links: other processes own those. Leave assignee unset and priority at the project default unless the user says otherwise.

## Source rules

- **Wiki page** (`{{wikiSpace}}` space): read it whole per `docs/agents/issue-tracker.md`, images and comments included. Pull scenarios, rules, limits, and role names from the page; never invent them. Link the page.
- **Design prototype** (URL or screenshot): acceptance criteria cover only what is visible - layout, states, copy, controls. Rules the design cannot show (limits, validation, rate caps) go to **Open questions**, not criteria.
- **Plain notes**: feature-sized -> full template, ask for what you would normally read from a spec. Small -> Task with **Goal** + **Tasks** only.
- Anything you filled in from judgement is listed under **Open questions** in chat, never asserted as a criterion.
- Unsure whether it is a Task or a Story: ask. The wrong one buries a feature in a one-liner or pads a bugfix with empty sections.

## Writing rules

- Lead with **Goal** (1-2 lines). Reader should get the point in 5 seconds.
- Everything else is **bullets**. No long prose paragraphs.
- Cut: progress logs, "we decided to instead", history, anything not actionable. State the current decision, not how we got there.
- Short dashes `-` only, never long dashes. ASCII only.
- Use `->` for flows, `x3` for counts, backticks for commands/env vars/paths.
- Acceptance criteria are flat statements with real values: "Player can send a message (max 500 characters)", not "should be able to".
- Name the owner-confirmed decisions inline with date + who (e.g. "confirmed with <owner> 2026-06-15") so they are not relitigated.
- Scope tightly. Push anything bigger into a separate ticket and say so in **Out of scope**, citing the real key. Sibling not filed yet: say so in chat, never invent a key.

## Jira gotchas

- **Markdown checkboxes break.** `- [ ]` renders as literal `\[ \]`. Default to plain `-` bullets. Only when the user asks for checkable criteria: build the whole description as ADF (`heading`, `bulletList`, `taskList` nodes) and send `contentFormat: "adf"`. Each `taskItem` has `state: "TODO"` and every `localId` is a real UUID (`uuidgen`): a short id like `ac-1` saves fine and renders no checkbox. Fetch back with `responseContentFormat: "adf"` and confirm the `taskList` survived.
- The summary is plain text: `&amp;` or `&mdash;` arrive literally.
- Markdown `##` headings and `**bold**` convert cleanly; tables convert too. Markdown writes need no re-read.

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

## Links

- <spec page, design, vendor docs>

## Out of scope

<comma list, point to follow-up tickets>

## Acceptance criteria

- <observable, testable outcomes>
```

Infra/DevOps tickets: swap **Scope** for **Provision** (services as bullets) + a **One-time bootstrap** section. Cross-cutting infra a module depends on: swap **Out of scope** for **Key assumptions**. Link a prior infra ticket as a worked example if one exists.

Spikes (research with no code output): **Context** (what and why) + **Links** + criteria as deliverables ("Compare cost, coverage, integration effort", "Written recommendation", "Client confirms the decision" when sign-off is the end point). Compliance-sensitive spikes (payments, KYC/AML, data handling) name the licence jurisdiction that constrains them.

## Flow

1. If rewriting: read the issue whole per `docs/agents/issue-tracker.md` (`atlassian-read`; comments and images included) - a rewrite that drops a decision buried in a comment or a screenshot is a regression.
2. Read the source per **Source rules**, plus any context it references (Slack decision, sibling ticket).
3. Find the epic: `project = {{trackerKey}} AND issuetype = Epic AND summary ~ "<module>"`. Then list its children (`parent = <EPIC-KEY>`) to see what is already covered and which keys to cross-reference.
4. Source covers several flows: propose the split (one line per issue) and get a yes before drafting.
5. Draft in chat with **Open questions** listed separately. Create or edit only after the user confirms. Report the ticket key + URL.
