# ADR-0052: Signed internal API for service-to-service calls

**Date**: 2026-11-12
**Status**: Accepted
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
  They are not in `/openapi.json`, and the handler reads the caller from `context.internalCaller`
  (`InternalContext`).
- **No session, ever.** Before a handler runs, the runtime strips every header core reads a
  session or identity from (`cookie`, `authorization`, `proxy-authorization`, `x-user-id`,
  `x-username`). `InternalContext` types `auth` as `never`. A handler that calls
  `adminGuard.assert` on a signed call that carried an admin cookie gets a 401.
- **HMAC-SHA256 request signing.** The caller sends `x-openora-service`, `x-openora-timestamp`
  (unix ms) and `x-openora-signature`. The signature is the hex HMAC over
  `service\naudience\ntimestamp\nMETHOD\npath+query\ncontent-type\nsha256hex(body)`. The audience
  is the `SERVICE_NAME` of the service called: the server signs with its own name, so a call
  signed for one service is refused by another. `content-type` is the header as sent, or empty.
- **Order of checks.** The server checks the headers' shape and the 60s clock window first, then
  reads the body, then compares the signature in constant time against every configured secret.
  A stale or unsigned call is refused without reading its body.
- **Secrets from `INTERNAL_API_SECRETS`.** This is a comma list, and each secret is at least 32
  characters. The first secret signs and any of them verifies. When the variable is unset, the
  surface is off and every internal path answers 401.
- **Failure shape.** Any auth failure gets a 401 with an empty body, whether the route exists or
  not, so an unsigned caller learns nothing about the routes. A body over 1 MiB gets a 413. A signed
  call to an unknown route gets a 404. Each refusal logs one warn line with the claimed service
  name, method, path and reason. The signature is never logged.
- **Client.** `createInternalClient({ baseUrl, serviceName, audience, secrets, timeoutMs })` takes
  the `INTERNAL_API_SECRETS` value, signs each call with its first secret and applies
  `AbortSignal.timeout`. It never retries. It refuses a path that does not start with `/` or that
  has a dot segment, `?` or `#`: inputs travel in the signed JSON body, and percent-encoding a
  segment is the caller's job. Every failure throws an `InternalApiError` whose `kind` is
  `timeout`, `network`, `client` (4xx or a refused path) or `server` (5xx or an unreadable reply).
- **The edge denies it.** The internet-facing edge (load balancer, ALB or reverse proxy) MUST
  deny `/internal/` for every request. Services call each other directly over the private
  network, never through the public edge.
- **Replies are not signed.** Replies are trusted because they travel on the private network the
  edge closes off. A caller still parses a reply with its schema. mTLS or a mesh is the upgrade
  when that network is not trusted.
- **Idempotency on money.** A handler that moves money MUST take an idempotency key in the signed
  body and apply the operation once per key.
- **No rate limit.** A per-caller cap on a trusted peer does not stop a peer that has leaked the
  secret. On the money path it turns a traffic spike into declines, and there is no limit value
  that makes sense without per-route semantics. Rate limiting stays on the public surface.

### Why HMAC and not mTLS for now

mTLS needs a CA, certificate issuance and rotation, and TLS termination at the process or in a
mesh. Operators deploy on whatever they choose. HMAC needs one environment variable and no
infrastructure. mTLS or a mesh can be added later as transport protection underneath, without
changing the route surface.

### Rotation

1. Generate a new secret and append it on every service: `INTERNAL_API_SECRETS=old,new`.
2. Deploy all of them. Every server now accepts both, and callers still sign with `old`, so a
   service not yet redeployed keeps working.
3. Once every service runs step 2, put `new` first on every service: `INTERNAL_API_SECRETS=new,old`,
   and deploy again. Callers now sign with `new`.
4. Remove `old` from every service and deploy again. Calls signed with `old` now get 401.

### Not covered here

Third parties, such as an operator's own tools, should authenticate with operator-issued JWTs
verified against a JWKS. That is a separate future adapter with its own identity model, and it
should not reuse the shared secret.

## Consequences

- Every holder of the secret can sign as any service name. The name identifies the caller among
  trusted peers but does not prove it. A handler that must restrict callers allow-lists
  `context.internalCaller`, and that check is only as strong as the secret's custody.
- There is no nonce store, so a captured request can be replayed within the 60s window against
  the same service. That is why money handlers take an idempotency key in the signed body.
- A deployment that leaves `/internal/` open at its edge exposes the surface to anyone who holds
  or guesses the secret. Closing it at the edge is part of running a split install.
- `baseUrl` is an origin. The client appends `/internal/v1` and the route path.
- A request body is buffered up to 1 MiB before verification. Larger payloads belong in events or
  object storage.
