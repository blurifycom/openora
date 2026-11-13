# AGENTS.md

Canonical brief for AI agents and humans. Per-tool files are generated from `.rulesync/`; edit the source, then run `pnpm gen:agents`. Never hand-edit generated mirrors.

## Mission

Open-source, headless, plugin-based, AI-native igaming framework. Consumers extend modules, plugins, and adapters in their own repo; this repository ships backend contracts, runtime, SDK, tooling, and no consumer UI.

This is real-money regulated gambling. A defect here moves a player's money or breaks an operator's licence, so the money, KYC, responsible-gambling and audit standards get read before those paths change, not after. "Operator" is the company running an igaming on this platform; "player" is the person gambling. `docs/platform/glossary.md` defines the rest of the vocabulary.

## Repo map

- `packages/core/` - the one published package, `@openora/core`, exposed as subpaths. `src/<domain>/<module>/` holds every module; `src/contracts/` the shared schemas and adapter ports; `src/server/` the node engine (db, auth, kernel, plugin-host, `createApp`); `src/react/` the frontend consumption surface.
- `packages/testing/`, `packages/mcp/`, `packages/create-openora/` - test harness, the consumer-facing MCP server, the scaffolder.
- `apps/mcp-server-dev/` - the `oss-dev` MCP server this repo's agents use.
- `tools/` - generators (`gen/`), lint gates (`lint/`), db helpers (`db/`), consumer templates.
- `docs/` - `platform/` what it is, `guides/` how to do a job, `standards/` the rules, `adapters/` vendor binding, `modules/` a module's own surface, `adr/` why. `docs/catalog.json` is generated.
- `extensions.config.ts` - the one list of enabled plugins. An overlay lives in `extensions/<name>/` in a consumer's repo, not here.

## Orient before reading files

- `docs/catalog.json` is the generated surface: every module, table, route, event, adapter port, config field, agent tool and action type. Read it, or call the `oss-dev` MCP tools (`catalog-overview`, `list-modules`, `describe-module`, `list-routes`, `list-adapters`, `schema-get`, `docs-search`) instead of grepping.
- `pnpm setup` boots infra, migrates, and prints a summary. `pnpm dev` runs it. `pnpm verify` is the gate CI runs; it ends with `pnpm check:drift`.

## Load the right owner

- Universal engineering baseline and a topical routing table: `conventions`.
- Ticket, spec, or design context: `docs/agents/issue-tracker.md` - read the whole ticket, comments and images included, before planning or reviewing against it.
- Events, jobs, realtime, and outbox choices: `messaging-and-microservices`.
- Module boundaries, DI, ports, and shared helpers: `docs/standards/module-structure.md`.
- Money, compliance, and audit: read `docs/standards/{money,compliance,audit}.md` before changing those paths.
- Wallet, custody rails, and the payment seam: `docs/modules/wallet.md`, then `docs/standards/custody.md`.
- The touched module's contract, schema, plugin, and catalog entry define its current surface. A module carries a nested `AGENTS.md` only to point at its owning rule; rules themselves live in `.rulesync/rules/`.

## Quick destinations

- New module, route, table, seed, schema, enum, adapter, config, hook, or integration: use the matching generator and the topical standard named by `conventions`.
- Cross-module work: use a command port, domain event, shared contract, or read-only `/schema` subpath as defined in `docs/standards/module-structure.md`.
- Async or cross-process work: choose the channel in `messaging-and-microservices` before implementation.
- A bug: reproduce it before fixing it, as a failing E2E through `bootTestApp` or the flow against `pnpm dev`; the fix turns that same repro green. Can't reproduce: say what you tried and ask, never fix a guess. A login or access you don't have: ask the user.
- Docs or generated configuration: edit canonical source only. `pnpm regen` owns generated artifacts; `pnpm gen:agents` owns agent mirrors.

## Root guardrails

- Headless means no frontend UI belongs here; consumers build over `@openora/core/react`.
- This repository is public. A client's or vendor's name, and a client's ticket id, must never appear in a file name or in file content - `pnpm check:hygiene` fails the build on either. Describe the behaviour or name the port instead; ticket ids belong in the commit message and the PR description.
- The `SealedToken` services in `packages/core/src/compliance/sealed.ts` (RG enforcement, KYC writes, AML/SAR, ledger writes, RNG) are the ones an operator may never override. Do not add a rebind path around one.
- Admin routes resolve the shared `AdminGuard` in `plugin.ts`; the handler's first statement awaits `adminGuard.assert(context, <resource>, <action>)`.
- Serialize `pnpm regen` and `pnpm gen:agents` across agents. They rewrite shared generated state; one owner runs each command after parallel edits finish.

## Code Review Rules

Report defects a reader can act on: a concrete input or state and the wrong result it produces. Rank money, compliance, and security findings first. Skip what `pnpm verify` already fails on (lint, format, types, module boundaries, hygiene) and pure style preferences.

`docs/catalog.json` is gitignored and the `oss-dev` MCP server runs only locally, so a hosted review has neither. Read the touched module's contract, schema, and `plugin.ts` directly.

### Money and ledger

- Check every change to a balance, ledger, payment, or settlement against `docs/standards/money.md`.
- Flag floating-point money, a money mutation without a database idempotency guard inside its transaction, a debit and credit that can commit apart, and an auto-approval path that fails open.

### Compliance and audit

- Check KYC and responsible-gambling changes against `docs/standards/compliance.md`, and state-changing actions against `docs/standards/audit.md`.
- Flag a limit checked outside the transaction and lock that moves the money, a player-state mutation without an audit record, any update or delete of audit rows, and a rebind path around a `SealedToken` service.

### Authorization and trust boundaries

- Flag an admin handler whose first statement does not await `adminGuard.assert(context, <resource>, <action>)`, a player route that reads or writes another player's resource, an unverified webhook, and a secret or PII written to a log or an error message.

### Contracts and data

- Flag a breaking change to a route contract, event payload, or adapter port without a migration path, a Drizzle schema change without its migration, and a cross-module write that bypasses the command port.
- Flag a hand-edited generated file (`AGENTS.md`, `docs/catalog.json`, Drizzle output) instead of its source.

### Tests

- A new or changed route needs an E2E through `bootTestApp` with the happy path and one hostile path, per `docs/standards/testing.md`. Flag a test that mocks the database, a repository, or a sibling service.

## The roster

Delegate to the matching named agent; do not use a generic agent for a roster task. `planner` (a ticket or ask -> plan and test cases), `expert` (fuzzy ask -> requirements and acceptance criteria), `builder` (implement a plan), `module-author` (a whole new module), `plugin-author` (an overlay), `tester` (a hands-on walkthrough, attacks and a verdict table, plus the API tests it exercised), `docs` (prose audited against the code), `cleaner` (delete the surplus a branch added, before the PR), `operator` (consume the platform as a downstream operator would), and the reviewers `contract-reviewer`, `quality-reviewer`, `security-reviewer`.

# Engineering conventions

Use pure, composable functions and explicit typed wiring. Match local naming and structure. Prefer clear names, guard clauses, immutable construction, and side effects at boundaries. Reuse an existing helper before adding one.

| Change                                                  | Read first                           |
| ------------------------------------------------------- | ------------------------------------ |
| schema, type, enum-like value set                       | `docs/standards/types.md`            |
| SQL, Drizzle, migration, seed, DB tool                  | `docs/standards/database.md`         |
| function, service method, constructor                   | `docs/standards/functions.md`        |
| module, DI wiring, integration, cross-module dependency | `docs/standards/module-structure.md` |
| agent tool or action type                               | `docs/standards/module-structure.md` |
| error class or catch                                    | `docs/standards/errors.md`           |
| money movement or payment settlement                    | `docs/standards/money.md`            |
| wallet module surface or ledger invariant               | `docs/modules/wallet.md`             |
| rank ladder, rank rewards, account levels               | `docs/modules/gamification.md`       |
| deposit address, sweep, reconciliation, custody rules   | `docs/standards/custody.md`          |
| implementing or binding a payment/custody vendor        | `docs/adapters/`                     |
| KYC or responsible gambling                             | `docs/standards/compliance.md`       |
| audit production or consumption                         | `docs/standards/audit.md`            |
| async seam, event, job, or realtime                     | `messaging-and-microservices`        |
| test                                                    | `docs/standards/testing.md`          |
| comment or JSDoc                                        | `docs/standards/comments.md`         |
| prose doc, README, guide                                | `docs/standards/documentation.md`    |
| hook or typed client                                    | `docs/standards/react-sdk.md`        |
| commit or PR                                            | `docs/standards/git-delivery.md`     |
| failing gate or lint rule                               | `docs/standards/enforcement.md`      |

## Universal baseline

- Schema-first at trust boundaries. Infer types from their owning schema or row; do not hand-write duplicates.
- Literal config arrays/objects (option lists, key sets) use `as const`, not an explicit union type annotation - let TypeScript infer the literal types.
- No `any`, `interface`, decorators, reuse inheritance, suppressive casts, or default exports except `plugin.ts` and `drizzle.config.ts`.
- Keep third-party access behind an owning adapter port. Do not import another module's internals or create cycles.
- Do not hand-edit generated artifacts: migrations, `docs/catalog.json`, or per-tool agent mirrors.
- State-changing work is transactional where its standard requires it. Money work is also idempotent with a durable database guard inside that transaction.

# Messaging and microservices-readiness

Use the seams and contracts in code; this rule owns channel selection and the safety limits that affect a design.

| Need                                        | Channel                                          |
| ------------------------------------------- | ------------------------------------------------ |
| An answer or mutation now, including money  | Synchronous command port                         |
| A fact happened and others may react        | Domain event via `EventBus`                      |
| Durable, retryable, or scheduled work later | `JOB_QUEUE`                                      |
| Server-to-client push                       | `REALTIME_TRANSPORT` with an SSE `eventIterator` |

- Handlers and jobs are at-least-once: they must be idempotent. Money-adjacent work needs a durable database guard, not only an event ID or idempotency key.
- Money and any needed-now answer never travel over events. Use a synchronous, transactional command port.
- An event reporting a committed change on a money, compliance, KYC, RG or account-status path uses `emitInTransaction(tx, ...)` inside the same transaction (the outbox is always on). `emit()` is best-effort and only for informational, catalog and cache-invalidation events. Both throw on an invalid payload.
- A throwing handler is redelivered and dead-lettered to `oss:dlq:<topic>` after 5 deliveries (ADR-0045); plugin handlers are deduped per consumer via `processed_events`, a bare `bus.on` without a `consumer` is not.
- A Redis Streams deployment uses `SERVICE_NAME` as its durable consumer-group identity. Every independently deployed service sharing Redis needs a distinct name. A subscription that must run once per deployment, however many services load its plugin (the audit writer), passes `{ consumerGroup }` as the third argument of `ctx.events.on`; services of one deployment using the same group name compete for each event, and `createApp` scopes the name as `<REALTIME_NAMESPACE>/<group>` so two deployments sharing one Redis do not.
- `SERVICE_MANIFEST` picks the modules a process boots; `createApp` applies it to any plugin list. A manifest lists every module its modules `dependsOn` and every module that binds a port they require; infra overlays always load and their dependencies count. Boot logs each `optionalPorts` entry left unbound with what its module skips. A split fails closed on controls: it refuses to boot while a selected module's `controlPorts` entry (an RG limit, a geo check, an audit record) or `AdminGuard`'s permission resolver or security policy - checked on every manifest boot, which builds the guard before it serves - is unbound and the plugin list has the module that binds it. Whatever is missing fails the boot once, with one manifest line adding every module needed and theirs; with the shipped modules every split carries iam, identity, audit, mail, compliance, wallet, gaming, player-management, exchange-rate and chat. Without a manifest nothing changes.
- `JOB_WORKERS` picks the job queues a process consumes (default all; names, `prefix*`, `!` to exclude). To keep a long-running queue off the API replicas, run an extra full instance with the same `SERVICE_NAME` and `JOB_WORKERS=<queues>`, and give the replicas `JOB_WORKERS=!<queues>`. Processes sharing a `SERVICE_NAME` load the same modules, every queue needs a consumer somewhere, and a handler never assumes it runs where its job was enqueued.
- The shipped Redis Streams and BullMQ drivers do not honor `orderingKey`; use an overlay when strict ordering is required.
- `REALTIME_TRANSPORT` is Redis Pub/Sub (`RedisPubSubRealtimeTransport`, auto-bound on `REDIS_URL`, no in-process fallback - ADR-0031) - fire-and-forget UI push, not a durable event: a message published while nobody is subscribed is simply lost, which is why a realtime channel carries a change _signal_ the client refetches, never the state itself. Channels, signals, presence and the revocation channel are prefixed with `REALTIME_NAMESPACE`, which defaults to `SERVICE_NAME`. The two are opposite requirements: `SERVICE_NAME` must differ per service (consumer group), `REALTIME_NAMESPACE` must match across the services that push to the same clients, and must differ between deployments sharing one Redis. A service that sets `SERVICE_MANIFEST` must set both, or the boot fails. A manifest entry takes one flag, `id:no-routes`: the module still binds its ports, handles its events and runs its jobs, but its router is discarded, so it serves no HTTP route. Its router factory still runs, because several modules construct the service their events and jobs read, or schedule their jobs, inside it (the audit writer assigns `svcRef` there); a factory that guards the HTTP surface takes `options.mounted` and skips that guard when it is `false`. Use it for a module a kept module `dependsOn` but whose surface the service must not expose (identity's sign-in, whose country gate lives in the compliance module). A manifest that names identity must name audit too, since identity `dependsOn` it, or the boot fails on the missing dependency. An unknown flag, or the flag on an infra overlay or an unknown id, fails the boot. `RealtimePresence`/`getOnlineUserIds` are shared across replicas via `RedisPresenceStore`, a per-channel sorted set scored by each member's last heartbeat and read with a TTL cutoff, so a crashed replica's members self-expire instead of lingering forever.
- Chat and social read identity data through the `ACCOUNT_READER` port, never by joining identity or profile tables. Identity binds the same-database reader, live on every read. Chat on a database of its own sets `IDENTITY_SERVICE_URL` (the identity service's private origin), `IDENTITY_SERVICE_NAME` (its `SERVICE_NAME`, default `monolith`) and `INTERNAL_API_SECRETS`; it then reads over the ADR-0052 internal API with a 500ms timeout and keeps each account it asked for 30s in a per-process cache of at most 10,000 entries; concurrent cold reads of one id share one call, and a miss is never cached. Past 10,000 distinct accounts in play (a room roster or online count that large) reads go cold every time. Reads that decide a privilege or a privacy gate skip that cache (`{ fresh: true }`): every `AdminGuard` check, creating or accepting a room invite, the invite list's exclusion check, the viewer's staff check on a roster, and the closed / `allowFriendRequests` / `showOnlineStatusToFriends` reads in social. Only the chat plugin binds the remote reader, so social on a database of its own needs chat in the same process. The identity service answers only the callers named in `ACCOUNT_READER_CALLERS` (a comma list of `SERVICE_NAME`s; unset refuses every caller); this guards against misconfiguration only, because one install-wide secret signs as any caller name. A failed call fails closed: an access decision refuses, and a chat or social route answers 503 `SERVICE_UNAVAILABLE` on a timeout, network failure or 5xx (a 4xx, such as a caller missing from `ACCOUNT_READER_CALLERS` or clock skew, stays a 500); only the avatars on a history page and a message author's profile degrade. Chat on a database of its own also resolves sessions remotely: it binds `REMOTE_SESSION_RESOLVER`, and `createApp` (the request middleware and the `AdminGuard` lookup) uses it instead of the local chain. Identity serves it at `POST /internal/v1/identity/session`, taking the forwarded `cookie` and `authorization` as body fields (the internal API strips session headers; chat forwards only the better-auth session cookie(s) and `authorization`, and a request with neither is unauthenticated without a call) and running `resolveSessionChain`, the one function the local middleware also runs: session, idle touch, 2FA flag, `touchLastSeen`. Callers are named in `SESSION_RESOLVER_CALLERS` (same shape and limits as `ACCOUNT_READER_CALLERS`; a separate list because this route accepts credentials; it also gates the admin-security route below). Chat caches a confirmed session 5s (`SESSION_CACHE_TTL_MS`) in a `TtlCache` (`@openora/core/server`, shared with the account reader) of at most 10,000 entries keyed by sha256 of the credential, coalesces concurrent asks for one credential, and never caches a refusal (unknown, expired, idle) or an answer a purge overtook. `identity.session.revoked`, `identity.sessions.revoked_all` and `identity.user.deactivated` purge the user: the handler runs on one chat replica (consumer group), so it republishes on `REALTIME_TRANSPORT` (`chat:session-purge`) and every replica drops the user's entries. The player's own sign-out emits no event, so it takes up to the 5s TTL to reach chat, as does a 2FA-requirement change. A call that cannot reach identity (timeout, network failure, 5xx) answers 503 `SERVICE_UNAVAILABLE` on a protected route (never a stale or guessed identity; public routes still serve); a 4xx or an unparseable reply is unauthenticated, 401. The first failure is logged, then at most one summary per 30s with the count and the last error kind. The purge payload is validated with zod; a malformed one is ignored with a warning. `AdminGuard` in remote mode reads the `context.auth` the middleware already resolved, with no second resolve. Admin security (enrolled 2FA, device binding, IP policy) is decided by identity, never by chat's database: chat binds `ADMIN_SECURITY_POLICY` to `RemoteAdminSecurityPolicy`, which posts to `POST /internal/v1/identity/admin-security` with the check, user, session, ip and user agent in the signed body, never caches a verdict, and fails closed (503 when identity is unreachable). The `session_intact` check also refuses an ended or missing session, so a revoked admin session is refused within the 5s window. Same boot checks as the account reader (one client, `IDENTITY_SERVICE_URL`). The boot fails when `IDENTITY_SERVICE_URL` is set in a process that serves identity itself (no `SERVICE_MANIFEST`, or one naming identity without `:no-routes`), and in production when it is not https unless `IDENTITY_SERVICE_ALLOW_HTTP=true` (for a service mesh that encrypts the hop inside the private network).

# Wallet

Routing only. Open the file you need; do not work from this list alone.

| Change                                                | Read                        |
| ----------------------------------------------------- | --------------------------- |
| Any balance change                                    | `docs/standards/money.md`   |
| This module's surface and its own invariants          | `docs/modules/wallet.md`    |
| Deposit address, sweep, reconciliation, custody rules | `docs/standards/custody.md` |
| Implementing or binding a custody vendor              | `docs/adapters/custody.md`  |
| Binding a synchronous PSP                             | `docs/adapters/payment.md`  |
