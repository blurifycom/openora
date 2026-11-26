# ADR-0050: Dependency-only modules provide but do not consume

**Date**: 2026-10-13
**Status**: Accepted
**Relates to**: ADR-0017 (service manifest), ADR-0030 (`SERVICE_NAME`), ADR-0049 (job worker selection).

## Context

A service manifest (ADR-0017) must list every module its modules depend on, and every module
that binds a port they require. Almost every module depends on `audit` or `identity`, so most
split services load them. A loaded module registers everything: its providers, but also its
event handlers, job workers, schedules, routers and MCP tools. Each split service has its own
`SERVICE_NAME`, so it receives its own copy of every event (ADR-0030). A module that two
services load only as a dependency therefore handles each event twice across the cluster - audit's
handlers, for one, would write each audit row once per service. Dedupe keyed on the consumer
does not help: the two copies run under different groups.

The consumer template runs chat as its own service, which loads identity, iam, audit, mail,
compliance, player-management, wallet, gaming, exchange-rate and tag as dependencies: without
this decision it ran compliance's deposit and RG evaluation handlers, tag screening, wallet's
balance push and the rest a second time.

## Decision

**Separate the modules a process selects from the ones it only requires.** The selected modules
are the manifest's entries named without `:no-routes`, and every infra overlay (they cannot be
flagged). A `:no-routes` entry is required only: today a manifest names every module its modules
need, and the flag is how it says "for what it provides". Without a manifest every module is
selected, so a monolith is unchanged. Every module still runs `register()`, so its providers bind
and its services work for the selected ones. Only a selected module consumes: event handlers,
agent trigger listeners, job workers, schedules and mounted routers.

**The registry withholds a required module's consumption as it registers.** `loadPlugins` marks
each `:no-routes` entry with `ModuleRegistryImpl.requireOnly`, the mark that already swapped its
routers for empty ones. Registration runs under `setOwner` (as for MCP tools and action types), so
`events.on`, `triggers.listen` and `jobs.worker` from a required module are recorded in
`registry.withheld()` with their owner and never reach `events.getAll()`, `triggers.getAll()` or
`jobs.getAll()`. `createApp` wires what is left, unchanged, and logs the withheld counts per
module (`notConsumed`) once the plugins are loaded. `JOB_WORKERS` (ADR-0049) then picks among
the selected modules' queues; a pattern that names only a required module's queue fails the boot
like any queue the process does not register.

**Router factories stay boot hooks that every module runs** (ADR-0038). A required module's
factory receives `{ mounted: false }`, as before, and skips its `jobQueue.schedule` calls, so only
the selecting process upserts the schedules. This guard in each scheduling factory (compliance, chat, gaming,
wallet, tag, exchange-rate, bonus, gamification, sportsbook, notifications) is the minimum; a
declarative, owned `ctx.jobs.schedule` remains the cleaner shape once a schedule needs no
container read.

**No handler is consumed in every process.** Each shipped handler a dependency registers writes
shared state - the database, the shared Redis cache (iam's grant purge, gaming's catalog), the
realtime channel - so it is correct once per deployment, in the process that selects its module.
A handler that must reach state of every process (a per-process cache) republishes onto
`REALTIME_TRANSPORT`, which every replica of every service receives, as chat does to purge its
session cache. No per-registration "every process" flag was added: nothing needs it, and a
durable consumer group cannot deliver to every replica anyway.

**Audit dedupe is unchanged.** The audit subscriber joins the deployment-wide `audit` group
(`{ consumerGroup }`), so it already wrote one row per event; now a service that loads audit
`:no-routes` does not even join the group, and its `AUDIT_WRITER` still writes directly.

**Required modules could later be pulled in automatically**, instead of failing the boot, since
loading one no longer changes what the service consumes. Not done: the boot still names every
missing module and the manifest line to paste.

### Alternatives considered

- **A consumer group per owning module**, so a module's handlers run once per cluster wherever it
  is loaded. Infra overlays deliberately run per service, and it renames every durable group.

## Consequences

**Positive:**

- No duplicate side effects across split services, and shorter manifests.

**Negative / trade-offs:**

- A breaking change for any deployment that relied on a `:no-routes` module's handlers, jobs or
  schedules running in that service: select the module there (drop the flag), or in another
  process. Every module must be selected somewhere, or its consumption runs nowhere.
- A worker registered from a router factory, after `register()`, is attributed to no module and
  consumed everywhere. No shipped module does that.
- In a process on the in-process job queue (no `REDIS_URL`), a job enqueued for a required
  module's queue has no worker there. A split without Redis cannot deliver events either.

**Neutral:**

- A monolith is unaffected: every module is selected.
