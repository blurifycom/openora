# Prompt enhancement

Turn a raw request into the brief a stranger could execute before editing files.
Use this as a pre-step for fuzzy, broad, multi-part, or under-specified asks.

## When to run

- Run when scope, target, success criteria, or constraints are unclear.
- Skip when the request is precise and self-contained, such as a specific mechanical edit or factual question.
- Match effort to the ask - a small task needs a one-line brief, not a design document.

## Method

1. Restate the intent in one line.
2. Classify it as build, review, debug, refactor, docs, research, or ops.
3. For build work, use the `enhance-intent` MCP tool and stop this workflow.
4. Gather only context that changes the plan: ticket, ADRs, catalog, relevant code, and rule documents.
5. Surface only blocking ambiguities.
6. Emit the brief below.

## Brief

- Objective - outcome in priority order.
- Scope - included and explicitly excluded work.
- Context - load-bearing facts with source links.
- Constraints - conventions, module layering, dependency budget, and public OSS surface.
- Deliverables - concrete artifacts that prove completion.
- Guardrails - protected areas and required confirmation points.
- Open questions - only decisions that block progress.

## Modes

- Return for approval by default for non-trivial or ambiguous work.
- Enhance then proceed only when an orchestrator passes the completed brief to a subagent.

## Rules

- Preserve intent and never invent scope.
- Gather context after scoping, not before.
- Enhance once at the top of the workflow.
