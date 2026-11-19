# ADR-0060: Chat ports and admin grants over the internal API

**Date**: 2026-11-14
**Status**: Accepted
**Relates to**: [ADR-0054](./0054-signed-internal-api-for-service-calls.md) (signed internal API), [ADR-0055](./0055-audit-outbox-shipper.md) (audit outbox).

## Context

A split install can run chat on a database of its own. The service that keeps the money path then
needs two chat answers it cannot read from a table: who a player has blocked (`CHAT_BLOCK_READER`)
and whether a chat transfer may go ahead (`CHAT_TRANSFER_CHECK`). In the other direction, the chat
service holds no role assignments, so the admin permission resolver iam binds reads a table that is
not in its database.

## Decision

**Chat serves its two read ports.** The service that loads chat answers a service that does not, so
that service needs no chat module and no chat tables:

| Port                  | Route                                                       | Callers allowed by            |
| --------------------- | ----------------------------------------------------------- | ----------------------------- |
| `CHAT_BLOCK_READER`   | `POST /internal/v1/chat/blocks/{excluded,blocked,blockers}` | `CHAT_BLOCK_READER_CALLERS`   |
| `CHAT_TRANSFER_CHECK` | `POST /internal/v1/chat-commands/transfer-check`            | `CHAT_TRANSFER_CHECK_CALLERS` |

Each variable is a comma list of `SERVICE_NAME`s, and unset refuses every caller. The wire schemas
and paths live next to the ports in `@openora/core/contracts`, so the server and the client share
them.

**`chat-remote` binds the client.** The plugin binds both ports to a client of these routes when
`CHAT_SERVICE_URL` is set (`CHAT_SERVICE_NAME` is the chat service's name, default `chat`; the
client times out at 500ms). The chat plugin refuses to boot while `CHAT_SERVICE_URL` is set, so a
process never binds a port twice. A manifest that names `chat-remote` with `CHAT_SERVICE_URL`
unset fails the boot with "set CHAT_SERVICE_URL". Neither read is cached. A block read that cannot
be answered throws a 503 `SERVICE_UNAVAILABLE` and a transfer check throws
`ChatTransferCheckUnavailableError`, which `checkChatTransfer` turns into a `chat_unavailable`
refusal.

**Iam serves admin grants.** The service that owns iam answers `POST
/internal/v1/iam/admin-permissions/{grants,super-admin}` to the callers in
`ADMIN_PERMISSION_CALLERS` (unset refuses every caller). The chat service, with `IDENTITY_SERVICE_URL`
set, binds `ADMIN_PERMISSION_RESOLVER` to a client of those routes. It caches nothing: the owner's
resolver caches for seconds and purges on every grant change, and a copy here would add its own
staleness to a revoked admin's access. A failed call throws, so `AdminGuard` refuses the request
and the failure is not recorded as a denial. The chat plugin `dependsOn` iam, so its binding is the
later one and wins.

**The transfer check holds no lock.** It needs a transaction, and the caller's is in another
process, so the route runs it on a transaction of its own that ends with the answer. The block locks
the local binding holds until the caller commits do not exist across the gap: a block committed
after the answer and before the caller's money commits is not seen. Tip and transfer commands must
move money through `guardChatTransfer(port, tx, input, commit)` from `@openora/core/contracts`: it
checks, runs the caller's debit and ledger rows in `commit` on the caller's transaction, and checks
again before returning, throwing `ChatTransferRefusedError` on a refusal or a counterpart blocked
since the first check, so the caller's transaction rolls back. That narrows the window to the time
between the second answer and the commit; it never closes fully without a lock shared across the
two services. A caller that cannot accept it keeps chat in its own process.

## Consequences

- A process that does not load chat serves no chat route and has no chat tables to migrate.
- Three new allow-list variables, each refusing every caller while unset.
- An iam outage refuses chat's staff routes with a 503. Player routes do not read grants.
- Plugin order now matters for `ADMIN_PERMISSION_RESOLVER` in a chat service: the `dependsOn` on iam
  makes it deterministic.
