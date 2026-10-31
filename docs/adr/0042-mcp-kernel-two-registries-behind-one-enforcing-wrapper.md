# ADR-0042: MCP kernel - two registries behind one enforcing wrapper

**Date**: 2026-09-25
**Status**: Accepted

> **Update (2026-10-06)**: The MCP HTTP transport in core ([ADR-0043](./0043-mcp-http-transport-with-admin-bound-tokens.md)) is a second consumer with no hub in front of it, so it asks the kernel to drop the output keys a tool marks as personal, unless the operator switches that off; a run can now request that drop, and its audit record then hashes exactly what was returned and carries the client's address and agent. Without the request the kernel still returns allow-listed data as the module has it. A tool descriptor's output JSON Schema now describes only the allow-listed keys, because MCP clients validate structured output against the published schema. `AdminGuard.assertUser` now also refuses a deactivated account.

> **Update (2026-10-16)**: Which domain events may start an agent run is the operator's call: `PlatformConfig.agents.triggers.topics` lists them (none by default), and `MCP_KERNEL.listTriggers()` returns only those. The kernel's catalog version covers them, so a review bound to it goes stale when the list or a trigger's subject changes. A plugin cannot read the config in `register()`, so it listens with `ctx.triggers.listen((trigger, payload, envelope) => ...)` and `createApp` subscribes it to exactly the listed topics; with nothing listed, nothing is subscribed. Each trigger names the payload field of the player the event is about (`subjectField`: `userId`, `playerId` or none). Where a payload carries both, they name the same person and the user id is the subject: the emitter leaves the player id null whenever it could not read the player, and the segment reader maps a user id to its player. Overrides cover the events whose fields name someone else (an inviter, an admin) and those whose player has already left the population (a closed or deactivated account). A listener runs in line with the topic's other handlers and its errors are not retried, so it only enqueues a job and returns. Delivery is at least once, so it dedupes on the event id; a topic listed again after a gap can replay what the stream still holds, so it drops events older than it cares about; and the payload arrives raw, personal data included, so it never reaches a model as it is. `PLAYER_SEGMENT_READER` (bound by `tag`) pages the player ids a run may target, optionally only holders of some tags, and resolves a trigger's subject to a player id; an empty tag list or an unknown tag is refused rather than read as every player. Its population is every player whose profile is not closed and whose account is not deactivated (the back office's ban, which already removes the account from chat rooms and forfeits its bonuses); suspended and self-excluded players stay in it, so what may not be done to them is refused by the action type, not hidden from the agent.

> **Update (2026-10-20)**: `PLAYER_SEGMENT_READER.describe(tags)` answers, for each given tag, its name and how many players of the population hold it, so a segment picker shows a segment's size without paging it. It refuses what `page` refuses, and more than `MAX_PLAYER_SEGMENT_TAGS` entries, and returns counts only, never a player id.

> **Update (2026-10-23)**: An action type may declare `benefitsPlayer: true` when an approved proposal gives the player something of value (a bonus, a higher tier, a reward). A proposal store may refuse a benefit-granting action for a player at risk of harm; the flag lets it know which action types grant a benefit without naming them. `add_tag` does not declare it: its `vip` key grants a benefit while its risk keys protect the player and the operator, and the flag covers a whole action type, so until core can declare a benefit per payload a proposal store guards `add_tag` by its own configuration. Boot refuses a value that is not a boolean, and the descriptor and the generated catalog carry it as a boolean, false where the action type leaves it out. Like `reversible`, it does not change the catalog version: a consumer reads it from the descriptor each time it acts, so an action type that starts declaring it is guarded from then on without making every published review stale. For that harm check, compliance binds `RG_STANDING_READER`: a player's responsible-gambling standing as facts only - whether play is restricted, the exclusions in force, when the last self-exclusion and cooling-off ended, active monitoring flags, limits with any raise or removal the player asked for that has not applied yet, and up to four windows of deposits, stakes and wins priced into the fx pivot at today's rates, a window reading as unknown rather than partial when a currency cannot be priced. The windows count completed deposits and ledger stakes; they are not the figures a limit is enforced against. It holds no free-text reason and no admin id, draws no conclusion, and enforces nothing: wagers, deposits and logins are still refused by their own gates. `WALLET_READER` gains optional reads of the same kind (lifetime withdrawals, last deposit, turnover, recent withdrawal requests counted as the auto-approval velocity check counts them), and the tag module keeps a `recent_depositor` tag, off by default, so a segment can name the players who deposited within the rule's window; no agent may assign it. A deposit assigns it only while the rule is enabled, so it fills from then on with no backfill, and the daily sweep removes it, so a holder can keep it up to about a day past the window. A wallet reader that cannot say when players last deposited leaves it neither assigned nor swept.

> **Update (2026-10-29)**: An action type may declare what its payload means for a proposal store, where one flag for the whole type cannot. `benefitsPlayerWhen: { field, values }` names the payloads that give the player something of value - `add_tag` declares `{ field: 'tagKey', values: ['vip'] }`, so a proposal store guards a vip tag like a `benefitsPlayer` type and leaves the protective tags alone, without configuring it. `distinctBy` names the payload field that tells two proposals of the type for one player apart - `tagKey` for `add_tag`, `withdrawalId` for `hold_withdrawal` - so a store that keeps one open proposal of a kind per player keeps one per value, and a pending vip tag no longer holds back a high-risk tag. Boot refuses `benefitsPlayerWhen` beside `benefitsPlayer: true`, a field the payload schema does not declare, a value that field refuses, and a `distinctBy` field that is optional or not a string or number. The descriptor carries both, null where the type leaves them out, and the generated catalog carries their literals; like the flags they do not change the catalog version.

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

Consumers reach both registries only through `MCP_KERNEL`, which `createApp` binds sealed
(`Container.registerSealed`) after every plugin and the composition root have registered, so
neither an overlay, the composition root nor a holder of the container `createApp` returns can
replace it: a later registration throws. The kernel wrapper, not the runtime, enforces:

- **Shape at registration.** Tool inputs and action payloads are a top-level `z.object`;
  conditional rules go in `.superRefine()`. Every number is `z.coerce.number()` with both bounds,
  every string is bounded, every array has a maximum, free-form maps are refused, and schemas
  must convert to JSON Schema. A player is referenced by its id (`UuidSchema`); core defines no
  pseudonym format, because pseudonymising is the hub's job. A money amount is a decimal string,
  as everywhere in the platform (`docs/standards/money.md`), so it needs a maximum length like
  any string, and an action type that takes one checks its value in `.superRefine()`. A tool's
  output schema may not let undeclared keys through at any depth - no loose or catchall object,
  record or untyped field - so its parse strips them under every allowed key. A violation fails
  boot with the field path and the fix.
- **IAM per call.** The run's actor (an admin, an agent acting for an admin, or an MCP token
  owned by an admin) resolves to one admin, whose grants are checked by `AdminGuard.assertUser`
  before a handler, a precondition or an executor runs - the same enforcement point as every
  admin route, including the denial audit event.
- **Output allow-list.** The handler's output is parsed by its schema and only allow-listed keys
  leave the kernel. A schema mismatch returns `output_invalid`, never the raw output.
- **Error codes, never messages.** A handler returns a declared code by throwing `McpToolError`;
  any other exception becomes `internal_error`. Validation failures return field paths and
  messages without input values.
- **An audit record per call**, with tool id, schema version, actor, correlation id and SHA-256
  hashes of the parsed input and the redacted output. If the record cannot be written the call
  fails with `audit_unavailable` instead of returning data. An action execution retries the
  write first, because by then the executor's effect is committed. Hashing is total: anything
  nested deeper than 64 levels hashes as a fixed marker, and a tool call that fails outside its
  handler still writes its record, as `internal_error`.
- **Preconditions before proposals.** Each action type declares a precondition the hub must pass
  before a proposal is created. It runs under the action type's IAM check and writes no audit
  record. It is not re-run at execution, where the executor guards its own state under its own
  locks.
- **Replay-safe execution.** An executor receives `(payload, proposalId, actor)`. A replay while
  its effect still holds performs nothing and answers `already_applied`, so a retry after a crash
  is safe. Core stores no proposals, so executors key on the resulting state: after someone else
  changes that state (an admin removes the tag, resolves the held withdrawal), a replay may apply
  again or answer a declared refusal. The store that keeps proposals must not re-execute one it
  recorded as executed. An executor that moves money needs the durable idempotency guard
  `docs/standards/money.md` requires of every money mutation, keyed on the proposal id under a
  database constraint, the way `add_note` keys its note.

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
  `createApp` binds `MCP_KERNEL` sealed after every plugin, so a later registration throws, and
  the kernel factory is exported only from `@openora/core/testing`.
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
  the state it writes. `add_note` keeps the proposal id on the note it writes, under a partial
  unique index, so the note table carries a column of agent-proposal state: a replay of that
  proposal adds nothing, another proposal with the same text adds its own note, and a note an
  admin wrote never stands in for one.
- The earlier untyped `ctx.mcp.tool(definition)` form still registers, for compatibility, but
  the kernel does not serve it.

**Neutral:**

- A held withdrawal (`on_hold`) is now reachable through the `hold_withdrawal` action type, and
  an admin resolves it with the existing approve and reject routes.
