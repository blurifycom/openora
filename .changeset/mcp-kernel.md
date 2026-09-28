---
'@openora/core': minor
'@openora/mcp': minor
---

MCP kernel. A module now registers agent **tools** with `ctx.mcp.tool(defineMcpTool({...}), factory)` and agent **action types** with `ctx.actions.register(defineActionType({...}), factory)` in its own `plugin.ts`. An agent runtime or an MCP transport reaches both only through the `MCP_KERNEL` token, never by importing a module. The kernel wrapper:

- rejects at boot a tool input or action payload that is not a top-level `z.object`, has a string without a maximum length (enums, UUIDs and ISO dates aside), a number without both bounds or without `z.coerce`, an array without a maximum, or a free-form map, and an action type without an IAM resource;
- checks the IAM grant of the admin behind the run's actor (`AdminGuard.assertUser`, the same enforcement and denial audit as an admin route) before a handler or executor runs;
- returns only the output keys on the tool's allow-list, maps any exception to a declared error code or `internal_error` (never the exception text), and writes one audit record per call (`mcp.tool.invoked` / `mcp.tool.failed` / `mcp.action.executed` / `mcp.action.failed`, with SHA-256 hashes of input and output). A call whose audit record cannot be written fails with `audit_unavailable`; an action execution retries the write first, because its effect is already committed.

An action executor is replay-safe on the state it writes: a replay while its effect still holds performs nothing and answers `already_applied`. Core stores no proposals, so after someone else changes that state a replay may apply again or answer a declared refusal. Whatever stores proposals must not re-execute one it recorded as executed.

Also new: the shared `RunContext` type; `PlatformConfig.agents` (run limits, retention, and a model allow-list of `<gateway>/<vendor>/<model>` ids with step timeout, fallbacks, capability flags and deprecation date, where the gateway must be listed in `agents.modelGateways`, `['openrouter']` by default); a trigger catalog derived from the domain events; and the IAM resources `agent` (`view`, `create`, `update`, `publish`, `run`), `agent-proposal` (`view`, `approve`, `reject`) and `agent-config` (`view`, `update`).

Who holds the new IAM resources after an upgrade: a Super Admin gets them at once, because a super-admin role's grants are derived from the permission statement at runtime, and so does the built-in static `admin` role. No other seeded or custom role is granted them. Grant `agent`, `agent-proposal` or `agent-config` to the roles that should run agents, review proposals or edit agent settings (`iam.setRolePermissions`) before a screen is gated on them. The kernel checks each tool's and action type's own resource, so an agent acting for an admin can only read and execute what that admin could through the Backoffice.

First registrations: tools `player.summary`, `wallet.activity`, `kyc.status`, `ggr.summary`; action types `add_tag`, `add_note`, `hold_withdrawal`, `send_to_manual_review`, `request_enhanced_kyc`. Tools return data as the module has it and declare which output keys carry personal data (`redact.personal`); pseudonymising it before a model sees it is the consumer's job. `IdentityReader` gains an optional `getUserIdByPlayerId`, which the wallet and compliance registrations need: an operator who binds their own `IDENTITY_READER` without it gets a boot warning, and those four registrations answer `internal_error` until it is added.

A withdrawal held by `hold_withdrawal` (`on_hold`) can now be approved or rejected by an admin through the existing routes; before, both refused anything but `pending`. Auto-approval still only ever takes a `pending` withdrawal.

`@openora/mcp` lists the agent surface: `list-agent-tools`, counts in `catalog-overview`, and a module's tools and action types in `describe-module`.

**Breaking (types):** a hand-written `ModuleRegistry` implementation, a test double for example, needs the new `actions` member, `mcp.getTools`, and the two-argument `mcp.tool` overload. A TypeScript `PlatformConfig` object literal needs `agents`; config files parse unchanged, because the section defaults. The earlier untyped `ctx.mcp.tool({ name, description, inputSchema, handler })` still registers, but the kernel does not serve it; move such a tool to the contract form. `createMcpKernel` is exported only from `@openora/core/testing`; production code resolves `MCP_KERNEL`.
