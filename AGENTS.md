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

- `docs/catalog.json` is the generated surface: every module, table, route, event, adapter port, config field. Read it, or call the `oss-dev` MCP tools (`catalog-overview`, `list-modules`, `describe-module`, `list-routes`, `list-adapters`, `schema-get`, `docs-search`) instead of grepping.
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

Delegate to the matching named agent; do not use a generic agent for a roster task. `expert` (fuzzy ask -> requirements and acceptance criteria), `dev` (implement a spec), `module-author` (a whole new module), `plugin-author` (an overlay), `qa` (automated tests plus a hands-on walkthrough), `docs` (prose audited against the code), `cleaner` (delete the surplus a branch added, before the PR), `operator` (consume the platform as a downstream operator would), and the reviewers `contract-reviewer`, `quality-reviewer`, `security-reviewer`.

# Engineering conventions

Use pure, composable functions and explicit typed wiring. Match local naming and structure. Prefer clear names, guard clauses, immutable construction, and side effects at boundaries. Reuse an existing helper before adding one.

| Change                                                  | Read first                           |
| ------------------------------------------------------- | ------------------------------------ |
| schema, type, enum-like value set                       | `docs/standards/types.md`            |
| SQL, Drizzle, migration, seed, DB tool                  | `docs/standards/database.md`         |
| function, service method, constructor                   | `docs/standards/functions.md`        |
| module, DI wiring, integration, cross-module dependency | `docs/standards/module-structure.md` |
| error class or catch                                    | `docs/standards/errors.md`           |
| money movement or payment settlement                    | `docs/standards/money.md`            |
| wallet module surface or ledger invariant               | `docs/modules/wallet.md`             |
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
- `emit()` is best-effort. Use `emitInTransaction()` only when the transactional outbox is explicitly enabled by `OUTBOX_ENABLED`, `AMQP_URL`, or `RABBITMQ_URL`; those AMQP variables enable the outbox but do not bind an AMQP broker.
- A Redis Streams deployment uses `SERVICE_NAME` as its durable consumer-group identity. Every independently deployed service sharing Redis needs a distinct name.
- The shipped Redis Streams and BullMQ drivers do not honor `orderingKey`; use an overlay when strict ordering is required.
- `REALTIME_TRANSPORT` is Redis Pub/Sub (`RedisPubSubRealtimeTransport`, auto-bound on `REDIS_URL`, no in-process fallback - ADR-0031) - fire-and-forget UI push, not a durable event: a message published while nobody is subscribed is simply lost, which is why a realtime channel carries a change _signal_ the client refetches, never the state itself. Channels are prefixed with `SERVICE_NAME` for the same cross-deployment isolation reason as the streams broker's consumer group. `RealtimePresence`/`getOnlineUserIds` are shared across replicas via `RedisPresenceStore`, a per-channel sorted set scored by each member's last heartbeat and read with a TTL cutoff, so a crashed replica's members self-expire instead of lingering forever.

# Wallet

Routing only. Open the file you need; do not work from this list alone.

| Change                                                | Read                        |
| ----------------------------------------------------- | --------------------------- |
| Any balance change                                    | `docs/standards/money.md`   |
| This module's surface and its own invariants          | `docs/modules/wallet.md`    |
| Deposit address, sweep, reconciliation, custody rules | `docs/standards/custody.md` |
| Implementing or binding a custody vendor              | `docs/adapters/custody.md`  |
| Binding a synchronous PSP                             | `docs/adapters/payment.md`  |
