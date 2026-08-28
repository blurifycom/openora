---
name: enhance-prompt
targets: ['*']
description: >
  Normalize any raw request into a grounded, structured brief before acting. The auto pre-step
  for orchestration skills and subagents: extract the real intent, gather scoped context (Jira +
  Confluence + Slack + roadmap + local docs), surface only blocking ambiguities, and emit
  objective / scope / constraints / deliverables / guardrails. Routes build-type asks into
  `enhance-intent`. Skips asks that are already precise. Use on any fuzzy, broad, or multi-part
  request, or at the start of a skill or agent that received a raw ask.
---

# enhance-prompt ({{name}})

Turn a raw, rambling ask into a brief a stranger could execute - before any file is touched. A one-line ask is a starting point, not a spec; a wrong reading executed confidently wastes far more than the enhancement costs.

Runs as a **pre-step**: skills and the orchestrator apply it to the incoming ask, then act on the enhanced brief - not the raw text.

## Run it, or skip it

- **Run** when the ask is fuzzy, broad, multi-part, or missing scope / target / success criteria.
- **Skip** - act directly - when the ask is already precise and self-contained: a specific edit, a single factual question, a mechanical change with an obvious target. Enhancing a clear one-liner just burns tokens.

Match effort to the ask: a small task gets a one-line restatement, not a full brief.

## Method

1. **Restate the intent** in one line. If your restatement might be wrong, gather context or ask - don't guess.
2. **Classify**: build (feature / adapter / page / route) · review or audit · debug · refactor · docs · research · ops. For a **build** ask, hand off to the `enhance-intent` MCP tool (server `oss`) - it adds the platform catalog, requirements checklist, and `pnpm gen` playbook - and stop here.
3. **Gather scoped context** - targeted, never a data dump (token budget matters). Pull only what changes the plan: Jira + Confluence via `atlassian-read` per `docs/agents/issue-tracker.md` (roadmap + related tickets, specs / decisions - comments and images included), Slack (recent decisions, `slack-reader`), local `docs/` + ADRs, past sessions. Scope first (which project, epic, timeframe), then fetch. Roadmap and known-issue threads are signal; general chatter is noise.
4. **Surface blocking ambiguities only** - the questions whose answers change what you build. Resolve the rest with stated defaults. Don't interrogate.
5. **Emit the brief**, sized to the task.

## The brief

- **Objective** - the outcome, in priority order.
- **Scope** - what's in; what's explicitly out.
- **Context** - the load-bearing facts found, with links (ticket, doc, `file:line`).
- **Constraints** - conventions, OSS-core boundary, dependency + token budget, confidentiality.
- **Deliverables** - what "done" produces.
- **Guardrails** - what not to touch; reversible-only; confirm-before-X.
- **Open questions** - only the blocking ones.

## Modes

- **Return for approval** (default): for non-trivial or ambiguous asks, present the brief, get a nod, then execute. Silently running a wrong reading multiplies the waste.
- **Enhance then proceed** (internal dispatch): the orchestrator enhances once at the top and passes the crisp brief to the subagent. Subagents act on the brief; they do not re-enhance their own input.

## Rules

- Intent-preserving: clarify the ask, never invent scope the user didn't want.
- Proportional: the brief is as short as the task allows.
- One pass at the top: enhance before context-gathering and before delegation, so the gather is targeted and the agents get a clean brief.
