# ADR-0043: MCP HTTP transport with admin-bound tokens

**Date**: 2026-10-06
**Status**: Proposed

## Context

[ADR-0042](./0042-mcp-kernel-two-registries-behind-one-enforcing-wrapper.md) gave the platform
one MCP kernel that every consumer goes through. The agent hub calls it in-process: its runs
build their own run context, so they need no network transport and no credential. An admin's
own MCP client is different. Claude Code, Claude Desktop or an analyst's tool runs on the
admin's machine and reaches the platform over HTTP, so the platform has to authenticate the
client, bind every call to one admin, and keep the endpoint off the player-facing surface.

The credential was decided downstream (downstream ADR 0007): an admin generates a token with a
mandatory lifetime in the Backoffice and pastes it into the client as a bearer header. There is
no authorization server, consent screen or client registry. The spike behind that decision
found the OAuth path workable but costly - a better-auth upgrade, mounting its HTTP handler,
consent and client-management screens, several new tables - while the MCP specification makes
authorization on the HTTP transport optional and every current client accepts a static header.

Building the transport surfaced three problems the kernel alone did not solve:

- The MCP SDK client validates structured tool output against the output schema the server
  publishes. The kernel published the schema of a tool's full output while returning only its
  allow-listed keys, so a client rejected a correct, redacted result.
- Tool output reaches whatever model sits behind the client. With no hub in front of this
  transport, nothing else strips the keys a tool marks as personal.
- `AdminGuard` did not check whether an account is still active. A session ends with the
  account; a token does not.

## Decision

**Tokens live in the iam module.** It owns a table of MCP tokens: the admin a token belongs to,
a label, a SHA-256 hash of the token and never the token itself, a short display prefix, the
creation time and a mandatory expiry, the revocation time, actor and reason, the last use and a
call count. The plaintext is returned once, when the token is created. The lifetime defaults to
30 days and is capped by configuration, at 90 days by default and never more than a year. Two
ports in contracts keep the transport and the identity module independent of iam: one
authenticates a bearer and records a call, the other revokes every token a user holds inside the
caller's transaction. Only an active admin can be issued a token; the issuing transaction reads
the owner with a share lock, so it cannot interleave with a deactivation. Each admin holds a
configured number of active tokens at most and can issue a configured number per hour.

**Two permissions.** One IAM resource lets an admin use MCP and manage their own tokens; another
lets an admin see every admin's tokens and revoke any of them, including an emergency revoke of
all. They are separate resources because the role matrix stores levels: on one resource, the
level that allows creating a token would also allow revoking everyone else's.

**The transport is part of core and off by default.** `createApp` mounts the MCP Streamable
HTTP endpoint only when `agents.mcp.enabled` is on, and mounts it ahead of CORS, cookie sessions,
caching and the oRPC handler, so none of them touches the request. It runs the official SDK
without session state - a fresh server and transport per request, JSON responses - and imports
the SDK, an optional peer dependency, only when the endpoint is enabled. Each request passes, in
order:

1. The host binding. The config refuses to enable the endpoint without an allowed host, and on
   any other host the request falls through to the normal 404, so the endpoint does not exist on
   the player domain.
2. The origin check. A request carrying a browser origin is refused unless that origin is
   configured; desktop clients send none.
3. A per-client-address limit, before any token is looked up.
4. Bearer authentication. A missing, unknown, expired or revoked token gets a 401 whose
   challenge names no OAuth metadata, so a client does not start an OAuth discovery.
5. Per-token rate limits for a minute and a day on the shared rate limiter, failing closed: an
   unreachable limiter answers 503.
6. `AdminGuard.assertUser` for the MCP permission, which now also refuses a deactivated account.

Only read-class tools are listed, narrowed to the ones the admin's grants allow; propose-class
tools and action types are never exposed. Every call still goes through the kernel, which checks
the tool's own permission and writes the audit record with the token id and the client's address
and agent. A call naming a tool the endpoint does not expose is refused and audited too, and the
kernel's input hashing is total, so no request can reach a tool and skip its audit record.

**Personal data is dropped by default.** The transport asks the kernel to drop the output keys a
tool marks as personal, so the audited output hash covers exactly what the client received, and
publishes output schemas without them. An operator can switch that off. The kernel's descriptor
now publishes the output schema projected to the allow-listed keys, so what a client validates is
what the kernel returns.

**Revocation is manual and automatic.** The owner or an overseer revokes a token by hand.
Automatic revocation commits in the same transaction as the change that causes it and keys on the
resulting state, so a failure rolls the change back and a retry finishes the job:

- the identity module revokes all of an admin's tokens when it deactivates the account, demotes
  it from admin, revokes all of its sessions (which also covers a forced logout, a two-factor
  reset and an email change), or completes a password reset or change;
- the iam module revokes the tokens of every admin who loses MCP access when a role loses the permission, is deleted or is unassigned, or when a first role assignment replaces the static admin role without it; grant changes and bulk revocations take the same lock, so they apply one at a time.

Players can never hold tokens, so their session revocations skip the token table. A bulk
revocation locks the token table first, so a token issued concurrently cannot survive it. The
per-request check stops a token at once; the persisted revocation keeps it dead after the
account or the access is restored.

**The kill switch is configuration plus revocation.** Turning the endpoint off removes it at the
next start. Revoking all tokens, or removing the MCP permission from a role, stops use without a
restart.

Rejected alternatives:

- **better-auth plugins.** The API-key plugin deletes expired keys, losing the history the
  Backoffice screen lists, and one misconfiguration turns a key into a session for every route.
  The MCP and OAuth-provider plugins require OAuth with login and consent. The agent-auth plugin
  is experimental, signs a fresh short-lived JWT per request, and reaches Claude Code only
  through a local proxy that exposes its own protocol tools instead of the platform's.
- **Stateful MCP sessions.** A read-only tool catalog needs no server state, and stateless
  requests scale across replicas without sticky routing.
- **Serving MCP through the oRPC handler.** MCP is its own JSON-RPC protocol with its own content
  negotiation, and that path would add credentialed CORS, cookie sessions and caching the
  endpoint must not have.
- **Describing tools with the SDK's high-level registration.** It rebuilds tool schemas from zod;
  the kernel already publishes validated JSON Schemas, and the low-level handlers keep the kernel
  the only enforcement path.
- **OAuth now.** It is the next step when a client cannot send a static header (Claude Desktop
  and claude.ai remote connectors), when a third party needs access, when an agent runtime moves
  out of process, or when MCP gains writes. It plugs in as a second authenticator behind the same
  port, without touching the transport or the audit.

## Consequences

**Positive:**

- An admin can query the platform from an MCP client under the same grants, audit trail and
  redaction as the Backoffice and the agent hub.
- The endpoint is off until an operator enables it, absent on hosts it is not bound to, and
  every token expires, can be revoked, and leaves an audit record per call.
- The active-account check in `assertUser` also stops agent runs acting for a deactivated admin.

**Negative / trade-offs:**

- An operator who enables the endpoint installs the MCP SDK next to core; a deployment that
  never enables it installs nothing extra.
- A stolen token reads what its admin can read until it expires or is revoked. The lifetime cap,
  the per-token limits, hashed storage and the per-call audit bound that exposure.
- Claude Desktop's remote connectors accept only OAuth, so Desktop needs a local bridge that adds
  the header; Claude Code sends it directly.
- The daily limit is a fixed 24-hour window that opens with the first request, not a calendar
  day, and every authenticated request counts towards both limits.
- Issuing a token needs a session with the MCP permission but no fresh second factor. A step-up
  needs a cross-module port into identity and a Backoffice flow, and is left to a later change.
- The host binding reads the request's host, so the backoffice proxy has to set the `Host` header
  itself and reject absolute-form request targets.

**Neutral:**

- A deactivated admin keeps a live Backoffice session until it expires, because the session-based
  `assert` does not check the active flag. That gap predates this decision and is left to a
  separate change.
