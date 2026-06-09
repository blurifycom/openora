# ADR-0017: Extraction readiness - service manifest, transactional outbox, command ports

**Date**: 2026-06-09
**Status**: Accepted; implemented (manifest boot + outbox seam + `WALLET_COMMANDS` reference; outbox off by default).
**Relates to**: ADR-0010 (event-driven broker direction), ADR-0014 (job-queue/realtime seams), ADR-0016 (event envelope).

## Context

ADR-0010/0016 made the inter-module *event* transport swappable so a module can be
extracted to its own service. Three gaps remained before extraction is actually
mechanical rather than a rewrite:

1. **No way to run a subset.** `createApp` always booted every module. "Run wallet
   as its own service" or "exclude a module from the monolith" had no switch.
2. **Events were best-effort.** `EventBus.emit` published fire-and-forget after
   commit. If the broker was down between commit and publish, the event was lost -
   unacceptable once a separate service depends on it.
3. **Synchronous cross-module money used shared tables.** Sportsbook debited the
   wallet by importing `@oss/modules/player/wallet/schema` and writing it inside its
   own transaction. Atomic and sanctioned, but it couples the two modules to one
   database, so neither can move without a rewrite.

## Decision

**Service manifest (deployable topology = config).** `SERVICE_MANIFEST` (comma-
separated module ids) selects which modules a process boots; unset = the full
monolith. Infra overlays (`kind: 'infra'` in `extensions.config.ts`) always load.
`applyServiceManifest` (`@oss/plugin-host`) does the filtering; `apps/api/src/extensions.ts`
applies it. `pnpm create:service <name> <modules>` scaffolds a thin host under
`apps/<name>/` that bakes a manifest and reuses the root registry - module code is
never copied. The same `wallet` package runs in the monolith or as its own service
with zero code change.

**Transactional outbox.** A new `EventBus.emitInTransaction(tx, topic, payload)`
writes the envelope to an `event_outbox` table within the caller's transaction
(atomic with the state change). An `OutboxRelay` polls pending rows and publishes
them to the `MESSAGE_BROKER` after commit, stamping `publishedAt`; delivery is
at-least-once and consumers dedup on `eventId`. Port `OUTBOX` (`@oss/adapters`),
impl `DrizzleOutboxWriter` + `OutboxRelay` (`@oss/db`), wired in `create-app`.
**Opt-in:** bound only when `OUTBOX_ENABLED` or a durable broker (`AMQP_URL`) is
set. In the default in-process monolith it stays off - `emit()`'s synchronous
fan-out is sufficient and `emitInTransaction` throws a guiding error. Per-event
`schemaVersion` is now real (`domainEventVersions` + `getEventVersion`; `eventCatalog()`
lists topics + versions).

**Command ports for synchronous cross-module calls.** When module A must mutate or
query module B synchronously (money, a needed-now value), it calls a port B owns,
passing its own `tx` handle - it does not import B's tables. Reference:
`WALLET_COMMANDS.debit(tx, { userId, amount })`, bound by wallet to
`WalletCommandsService`. In-process the debit runs on the caller's transaction, so
sportsbook's bet-insert + debit stay atomic; a remote wallet service later binds an
implementation that runs a saga, with no change to sportsbook. The consumer
declares `dependsOn: ['<owner>']`. A new `no-cross-module-schema-read` lint rule
(warning, in the existing oxlint boundary plugin - ADR-0015) surfaces every
remaining cross-module `/schema` read as an extraction-coupling checklist; it does
not block, since those reads are still sanctioned.

## Consequences

- Extracting a hot module is now: include it in a manifest (or `create:service`),
  enable the outbox + a durable broker, and replace its shared-table couplings (the
  lint warnings) with command ports / event-fed read models. No module-logic edits.
- The outbox makes monolith event timing eventual when enabled (relay poll), so it
  stays off by default to preserve synchronous in-process fan-out and existing test
  timing. Money is unaffected - it never flows over events.
- Reporting that reads other modules' tables (backoffice analytics) is left as
  synchronous JOINs for now; it converts to projections only when backoffice is
  actually extracted (a deliberate deferral - read models add eventual consistency).
- Boundary enforcement stays a single mechanism (the oxlint plugin, ADR-0015); the
  new rule is added there rather than as a parallel checker.

## References

- ADR-0010 - event-driven broker and microservices direction.
- ADR-0015 - boundary lint as a hand-written oxlint plugin (where the new warn rule lives).
- ADR-0016 - event envelope and transport-agnostic broker (the outbox publishes that envelope).
