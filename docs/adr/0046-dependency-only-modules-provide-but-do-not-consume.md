# ADR-0046: Dependency-only modules provide but do not consume

**Date**: 2026-10-13
**Status**: Proposed
**Relates to**: ADR-0017 (service manifest), ADR-0030 (`SERVICE_NAME`), ADR-0045 (job worker selection).

## Context

A service manifest (ADR-0017) must list every module its modules depend on, and every module
that binds a port they require. Almost every module depends on `audit` or `identity`, so most
split services load them. A loaded module registers everything: its providers, but also its
event handlers, job workers, schedules, routers and MCP tools. Each split service has its own
`SERVICE_NAME`, so it receives its own copy of every event (ADR-0030). A module that two
services load only as a dependency therefore handles each event twice across the cluster - audit's
handlers, for one, would write each audit row once per service. Dedupe keyed on the consumer
does not help: the two copies run under different groups.

Nothing ships split today, so nothing duplicates yet; extracting the first module would.

## Decision

Proposed, not implemented.

**Separate the modules a process selects from the ones it only requires.** The selected modules
are the manifest's and the infra overlays; the required ones are the `dependsOn` closure and the
port providers. Every module still runs `register()`, so its providers bind and its services
work for the selected ones. `createApp` wires consumption only for registrations owned by a
selected module: event handlers, job workers, schedules and mounted routers.

**The registry records the owner of each registration.** `ModuleRegistryImpl` already records it
for MCP tools and action types (`setOwner`); `events.on`, `jobs.worker` and `routers.add` would
carry it too. Router factories stay boot hooks that every module runs (ADR-0038); only the
mounting is filtered. Schedules move from router factories to a declarative, owned
`ctx.jobs.schedule`, so only a selected owner upserts them.

**Required modules could then be pulled in automatically**, instead of failing the boot, since
loading one no longer changes what the service consumes.

### Alternatives considered

- **A consumer group per owning module**, so a module's handlers run once per cluster wherever it
  is loaded. Infra overlays deliberately run per service, and it renames every durable group.

## Consequences

**Positive:**

- No duplicate side effects across split services, and shorter manifests.

**Negative / trade-offs:**

- A breaking change for any deployment that relies on a dependency's handlers running in a
  service that does not select it.
- Moving schedules out of router factories touches every module that schedules.

**Neutral:**

- A monolith is unaffected: every module is selected.
