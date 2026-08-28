# OSS core handoff

When an `add-feature` work item can only be fixed in `@openora/*` core, this consumer repo cannot edit it (the `guard-core.mjs` hook and `permissions.deny` block `{{ossDir}}/**`). Hand off to the platform-core twin skill instead of fighting the guard.

## When to hand off

- The fix requires changing a contract, schema, service, router, or platform seam in `@openora/*`.
- An overlay plugin / adapter swap / UI provider override / config change genuinely cannot express the behavior.
- Default bias: extend from the outside first; hand off only when you've confirmed the outside-in path doesn't exist. If unsure, say so in the plan (Step 3) and let the user decide before writing the order.

## Work-order template

Write to `~/.claude/plans/<ticket-key>-oss.md` so both repos and future sessions can read it:

```markdown
# OSS work order - <ticket-key>: <title>

## Goal

<what core must do, 1-2 lines>

## Unblocks

{{name}} feature <ticket-key> - <which downstream slice depends on this>

## Core surface to change

- <package / module / contract / adapter token, as specific as possible>

## Contract / schema impact

- <new or changed oRPC contracts, Drizzle tables, events; or "none">

## Acceptance

- <observable outcomes that prove the core change is correct>

## Dependency

{{name}} MR <url-or-TBD> stays in draft until this merges and a new @openora/core/\* version is consumed.
```

## Protocol

1. This consumer repo writes the work-order and **stops** that slice (keep delivering independent downstream slices meanwhile).
2. The user runs `/add-feature` inside the platform OSS repo (`{{ossDir}}`, separate cwd/session). It reads the work-order, implements, and opens its own MR there.
3. The consumer MR stays draft/blocked until the OSS MR merges and the consumer bumps the consumed `@openora/*` version. Link the two by the work-order path and the ticket key.
4. Note the handoff in the Jira ticket and the consumer MR description so the dependency is visible.
