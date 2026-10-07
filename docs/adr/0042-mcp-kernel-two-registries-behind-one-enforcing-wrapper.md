# ADR-0042: MCP kernel - two registries behind one enforcing wrapper

**Date**: 2026-09-25
**Status**: Accepted

> **Update (2026-10-06)**: The MCP HTTP transport in core ([ADR-0043](./0043-mcp-http-transport-with-admin-bound-tokens.md)) is a second consumer with no hub in front of it, so it asks the kernel to drop the output keys a tool marks as personal, unless the operator switches that off; a run can now request that drop, and its audit record then hashes exactly what was returned and carries the client's address and agent. Without the request the kernel still returns allow-listed data as the module has it. Its input hashing is now depth-capped, so every call is audited. A tool descriptor's output JSON Schema now describes only the allow-listed keys, because MCP clients validate structured output against the published schema. `AdminGuard.assertUser` now also refuses a deactivated account.

## Context

An agent hub (a premium package outside this repo) runs models that read platform data and
propose changes for an admin to approve. An MCP HTTP transport will let an admin's own MCP
client call the same reads. Both need to know what the modules offer without importing a
module, and both sit on a real-money path: whatever a model reads or triggers has to pass the
same authorization, audit and compliance rules as a Backoffice route.

A spike ran the candidate runtimes against real models and a stub harness. Four findings shape
the kernel, because no runtime fixes them:

- A tool input whose top level is a discriminated union is sent to the model as `oneOf` without
  `type: "object"`. Four different models then sent money amounts as strings and did not
  recover after validation feedback. With a top-level object every call was valid first time.
- Tool output and thrown errors reach the model verbatim in every runtime tested. A `pg` error
  carrying the SQL text of the failing query went straight to the model. A framework's output
  schema is not redaction: on a validation failure it forwards the raw output.
- A crash in the middle of an action followed by a framework restart executed the money step
  twice.
- A model proposed a "loss-mitigation" bonus to a player who had lost most of their deposits.
  Amount caps do not catch that; a domain rule evaluated before the proposal exists does.

The hub's runtime and its transport authentication were decided downstream (the agent hub
runtime on a thin AI SDK adapter, downstream ADR 0006; MCP clients authenticating with a
Backoffice-issued token rather than OAuth, downstream ADR 0007). Neither decision may leak into
core: the kernel has to serve any runtime and any transport.

## Decision

Modules register two different things, in their own `plugin.ts`, through two registries:

- `ctx.mcp.tool(contract, factory)` registers a **tool**: a call a model makes during a run.
- `ctx.actions.register(contract, factory)` registers an **action type**: a state change a model
  may only propose. An executor runs it later, after approval, under the approver's identity.

The contract is static data declared with `defineMcpTool` / `defineActionType` in the module's
`contract/` dir: id, title, description, schema version, the IAM `resource:action` it needs,
Zod schemas, the error codes it may return, and for a tool its class (`read | propose`) and
output allow-list, for an action type its reversible flag. The factory receives the container
once, when the kernel is built after every provider is bound, and returns the handler or the
`{ precondition, execute }` pair. The catalog generator reads the contract literals, so
`docs/catalog.json` and `@openora/mcp` list both registries without running anything.

Consumers reach both registries only through `MCP_KERNEL`, which `createApp` binds after every
plugin and the composition root have registered, so no overlay can replace it. The kernel
wrapper, not the runtime, enforces:

- **Shape at registration.** Tool inputs and action payloads are a top-level `z.object`;
  conditional rules go in `.superRefine()`. Every number is `z.coerce.number()` with both bounds,
  every string is bounded, every array has a maximum, free-form maps are refused, and schemas
  must convert to JSON Schema. A violation fails boot with the field path and the fix.
- **IAM per call.** The run's actor (an admin, an agent acting for an admin, or an MCP token
  owned by an admin) resolves to one admin, whose grants are checked by `AdminGuard.assertUser` -
  the same enforcement point as every admin route, including the denial audit event.
- **Output allow-list.** The handler's output is parsed by its schema and only allow-listed keys
  leave the kernel. A schema mismatch returns `output_invalid`, never the raw output.
- **Error codes, never messages.** A handler returns a declared code by throwing `McpToolError`;
  any other exception becomes `internal_error`. Validation failures return field paths and
  messages without input values.
- **An audit record per call**, with tool id, schema version, actor, correlation id and SHA-256
  hashes of the parsed input and the redacted output. If the record cannot be written the call
  fails with `audit_unavailable` instead of returning data. An action execution retries the
  write first, because by then the executor's effect is committed.
- **Preconditions before proposals.** Each action type declares a precondition the hub must pass
  before a proposal is created. It is not re-run at execution, where the executor guards its
  own state under its own locks.
- **Replay-safe execution.** An executor receives `(payload, proposalId, actor)`. A replay while
  its effect still holds performs nothing and answers `already_applied`, so a retry after a crash
  is safe. Core stores no proposals, so executors key on the resulting state: after someone else
  changes that state (an admin removes the tag, resolves the held withdrawal), a replay may apply
  again or answer a declared refusal. The store that keeps proposals must not re-execute one it
  recorded as executed.

`RunContext` (run id, actor, optional player pseudonym, catalog version, correlation id) is one
shared type, so the hub and the transport cannot disagree on it. `PlatformConfig.agents` holds
default run limits, retention and the model allow-list. A model id must be
`<gateway>/<vendor>/<model>` with the gateway in `agents.modelGateways`, which defaults to
`openrouter`: a bare id can be routed to a different gateway by the SDK, and core names no
gateway an operator cannot replace. The trigger catalog is derived from the domain event catalog, not registered separately.

Core returns data as the module has it. Pseudonymising players, stripping personal data and
trimming logs before anything reaches a model is the hub's job; a tool declares which output
keys carry personal data (`redact.personal`) so the hub can do that without knowing the module.
Tool ids may be dotted (`player.summary`); the kernel also publishes a `modelName` with dots
replaced, because the major model APIs reject dots in function names.

Rejected alternatives:

- **One registry for reads and writes.** A write needs approval, an idempotent executor and a
  reversible flag; a read needs none of them. One registry would let a model call a write as if
  it were a read.
- **Enforcement in the runtime.** Every runtime tested forwarded output and errors verbatim, so
  each runtime and each transport would re-implement the same rules, and one would get them
  wrong.
- **A rebindable kernel token.** An overlay could swap the wrapper and bypass IAM and audit.
  `createApp` binds `MCP_KERNEL` after every plugin, and the kernel factory is exported only
  from `@openora/core/testing`.
- **Pseudonymisation in core.** It needs a mapping store and belongs at the model boundary, which
  only the hub knows.

## Consequences

**Positive:**

- The hub and the transport share one enforcement path, and a module owns its agent surface
  exactly as it owns its routes.
- A tool that leaks a field, returns an unbounded input to a model, or skips IAM fails at boot or
  in the kernel's own tests, not in production.
- Every model-facing call leaves an audit trail that proves what was read without storing it.

**Negative / trade-offs:**

- Every tool call writes an audit row. That is the price of auditing reads, and it grows with
  agent traffic.
- The input rules constrain authors: a free-text field needs a `max`, a number needs coercion
  and bounds, and a union must be flattened.
- Without a proposals table in core, replay safety is each executor's responsibility, keyed on
  the state it writes. `add_note` recognises a replay by the same player, author and text, so a
  second approved proposal carrying exactly the same note from the same approver adds nothing.
- The earlier untyped `ctx.mcp.tool(definition)` form still registers, for compatibility, but
  the kernel does not serve it.

**Neutral:**

- A held withdrawal (`on_hold`) is now reachable through the `hold_withdrawal` action type, and
  an admin resolves it with the existing approve and reject routes.
