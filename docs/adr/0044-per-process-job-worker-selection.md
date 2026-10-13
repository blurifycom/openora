# ADR-0044: Per-process job worker selection

**Date**: 2026-10-13
**Status**: Proposed
**Relates to**: ADR-0014 (job-queue seam), ADR-0017 (service manifest), ADR-0030 (`SERVICE_NAME`), ADR-0038 (routers before workers), ADR-0042 (MCP kernel).

## Context

`createApp` registers a worker for every queue a loaded module declares, so every process
consumes every queue. That is right for a homogeneous fleet of replicas, but not for a job that
runs for minutes and mostly waits on an outside service - an agent run waiting on a model, a
large export. Such jobs take a share of every API replica's capacity and stretch its deploys,
since a replica drains its workers before it stops.

The service manifest cannot move them. A manifest service has its own `SERVICE_NAME`, so it
receives its own copy of every event, and a module pulled into it for its dependencies runs its
handlers a second time across the cluster. A job whose handler needs the full container cannot
live in a narrow service anyway: the MCP kernel (ADR-0042) is built in process from the tools and
action types of the modules that process loaded, so an agent run needs every module that
contributes them.

## Decision

**`JOB_WORKERS` picks the queues a process consumes.** `createApp` reads it at boot and
registers a worker only for the queues it selects; the filter sits in `createApp`, so it holds
for any queue driver. Entries are separated by commas or spaces:

| Value                     | Consumes                                 |
| ------------------------- | ---------------------------------------- |
| unset, blank, `*`, `all`  | every queue (the default, as before)     |
| `none`                    | no queue                                 |
| `reports.daily`           | that queue                               |
| `reports.*`               | every queue whose name starts `reports.` |
| `!pattern`                | not the queues the pattern matches       |
| only exclusions           | every queue but the excluded ones        |
| inclusions and exclusions | the included queues minus the excluded   |

A `*` anywhere but the end of a pattern, a bare `!`, `none` beside another entry, or `*` beside
a named queue fails the boot. So does an inclusion that matches no registered queue: a typo
would otherwise leave a worker process idle while its queue backs up. An exclusion that matches
nothing is allowed, because the module that registers the queue may not be installed. The boot
log lists the queues consumed and skipped.

It is environment-only, like `SERVICE_MANIFEST` and `SERVICE_NAME`: which queues a process takes
is deployment topology, and one image runs as either kind of process.

**Schedules are unchanged.** Every process still upserts its modules' schedules while building
routers (ADR-0038); the scheduler id dedupes them, and the selection only decides who consumes
the jobs they produce.

**The deployment pattern is an extra full instance.** To keep `reports.*` off the API replicas,
run one more instance of the same image, with the same plugin list and the same `SERVICE_NAME`,
and `JOB_WORKERS=reports.*`; give the replicas `JOB_WORKERS=!reports.*`. Sharing the
`SERVICE_NAME` makes the worker compete with the replicas for events instead of receiving a copy,
and keeps it in the same realtime and presence namespace. It serves HTTP like any instance but
needs no ingress.

### Alternatives considered

- **A process role (`SERVICE_ROLE=api|worker`).** Fixes one topology and cannot say which
  queues.
- **Role metadata on each worker registration.** A module cannot know how it is deployed.
- **A worker-only process without routers.** Router factories are boot hooks that workers rely
  on (ADR-0038), and the kernel needs every module loaded.
- **A manifest service for the queue.** Its own `SERVICE_NAME` means its own copy of every event.
- **Pausing workers in the driver.** Driver-specific, and the decision belongs to the host.

## Consequences

**Positive:**

- An operator can keep long-running jobs off the API replicas without code changes.
- Unset behaves exactly as before.

**Negative / trade-offs:**

- Every queue needs a consumer somewhere in the cluster; core cannot check that across
  processes, so a queue excluded everywhere backs up silently. Queue-depth monitoring catches it.
- Processes that share a `SERVICE_NAME` must load the same modules. The streams driver acks an
  event once per group, so a process without a handler for it loses the event for that group.

**Neutral:**

- Roll out the worker instance first, then the replicas with the exclusion; jobs enqueued in
  between wait in Redis.
- `/health` does not report the selection: it is a public contract, and the boot log is the
  record.
