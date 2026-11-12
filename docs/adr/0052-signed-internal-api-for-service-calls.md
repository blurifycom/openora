# ADR-0052: Signed internal API for service-to-service calls

**Date**: 2026-11-12
**Status**: Proposed
**Relates to**: ADR-0017 (extraction readiness), ADR-0030 (distributed-only production seams),
ADR-0049 (per-process job worker selection).

## Context

A split install runs modules in separate processes. Events cover most traffic between them, but
some calls need an answer now, such as a check on the money path. Those calls have no route to use.
The player and admin routers authenticate people through a session cookie or a bearer token. A
service has neither, and widening those routers to accept one would put service-only operations
on a surface that a browser can reach.

## Decision

- **A separate surface.** A plugin adds internal routes with `ctx.routers.addInternal(namespace,
factory)`, next to `ctx.routers.add`. They mount under `/internal/v1/*` on their own oRPC handler.
  They are not in `/openapi.json` and they never see the request's session: the context holds no
  `auth`, and the handler reads the caller from `context.internalCaller` (`InternalContext`).
- **HMAC-SHA256 request signing.** The caller sends `x-openora-service`, `x-openora-timestamp`
  (unix ms) and `x-openora-signature`. The signature is the hex HMAC over
  `service\ntimestamp\nMETHOD\npath+query\nsha256hex(body)`. The server checks the timestamp
  against a 60s window and compares the signature in constant time against every configured secret.
- **Secrets from `INTERNAL_API_SECRETS`.** This is a comma list, and each secret is at least 32
  characters. The first secret signs and any of them verifies. When the variable is unset, the
  surface is off and every internal path answers 401.
- **Failure shape.** Any auth failure gets a 401 with an empty body, whether the route exists or
  not, so an unsigned caller learns nothing about the routes. A body over 1 MiB gets a 413. A signed
  call to an unknown route gets a 404.
- **Client.** `createInternalClient({ baseUrl, serviceName, secret, timeoutMs })` signs each call
  and applies `AbortSignal.timeout`. It never retries. Every failure throws an `InternalApiError`
  whose `kind` is `timeout`, `network`, `client` (4xx) or `server` (5xx or an unreadable reply).
- **No rate limit.** A per-caller cap on a trusted peer does not stop a peer that has leaked the
  secret. On the money path it turns a traffic spike into declines, and there is no limit value
  that makes sense without per-route semantics. Rate limiting stays on the public surface.

### Why HMAC and not mTLS for now

mTLS needs a CA, certificate issuance and rotation, and TLS termination at the process or in a
mesh. Operators deploy on whatever they choose, and most terminate TLS at a proxy that would need
to forward the client identity. HMAC needs one environment variable, works behind any proxy that
does not rewrite the path, and needs no infrastructure. mTLS or a mesh can be added later as
transport protection underneath, without changing the route surface.

### Rotation

1. Generate a new secret and prepend it on every service: `INTERNAL_API_SECRETS=new,old`.
2. Deploy all of them. Callers now sign with `new`, and servers accept both.
3. Remove `old` from every service and deploy again. Calls signed with `old` now get 401.

### Not covered here

Third parties, such as an operator's own tools, should authenticate with operator-issued JWTs
verified against a JWKS. That is a separate future adapter with its own identity model, and it
should not reuse the shared secret.

## Consequences

- Every holder of the secret can sign as any service name. The name identifies the caller among
  trusted peers but does not prove it. A handler that must restrict callers allow-lists
  `context.internalCaller`, and that check is only as strong as the secret's custody.
- There is no nonce store, so a captured request can be replayed within the 60s window. Operations
  that move money carry an idempotency key in the signed body.
- Proxies in front of the API must pass internal paths and query strings through unchanged, or the
  signature fails.
- `baseUrl` is an origin. The client appends `/internal/v1` and the route path.
- A request body is buffered up to 1 MiB before verification. Larger payloads belong in events or
  object storage.
