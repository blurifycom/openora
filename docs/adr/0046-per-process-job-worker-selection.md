# ADR-0046: Per-process job worker selection

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
contributes them. Nor does a manifest service stay narrow: it fails closed on the controls the
rest of the install enforces (below). Every split loads iam and identity for AdminGuard, and with
them audit and mail; identity's controls pull in compliance, and compliance depends on wallet,
gaming, player-management and exchange-rate, player-management on chat. With the shipped modules
a split carries those ten before the module it was made for, which is close to the monolith.

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

**Add-ons follow the same rule.** The selection filters the workers registered through
`ctx.jobs.worker`, so an add-on moves its long-running jobs off the replicas only if it registers
them there, under a queue-name prefix of its own (`agents.*`, say) that one pattern selects. A
worker an add-on registers on `JOB_QUEUE` itself bypasses the selection and runs in every
process.

**A manifest fails closed on controls.** Some ports back a money, compliance, authorization or
audit control and are read with `c.has()`. An install without the module that binds one has
nothing to enforce, so a full boot runs without it, as before. A split service is different: the
module runs in another process of the same install, and a split that skipped the control would
let through what that process refuses. A plugin declares such a port in `controlPorts`, with the
module that binds it, and a `SERVICE_MANIFEST` boot refuses to start while one is unbound and the
plugin list has that module. Declared today: `RG_LIMITS` (wallet, gaming), `GAME_GEO_CHECK`
(gaming), `GEO_CHECK_COMMANDS` (identity, bonus, notifications), `MCP_TOKEN_REVOCATION` (identity)
and `AUDIT_WRITER` (mail). A port whose absence already fails closed - no KYC policy means every
gated withdrawal needs KYC, no risk tags send auto-approval to a human - is not a control port.
`AdminGuard` holds its own ports to the same rule on every manifest boot, which builds the guard
before it serves, admin routes or not: without `ADMIN_PERMISSION_RESOLVER` (iam) it decides on the
static role table, so an admin whose role was revoked still acts, and without
`ADMIN_SECURITY_POLICY` (identity) it skips the 2FA enrolment and session checks.

**A manifest is fixed in one edit.** A manifest boot fails once for everything the manifest leaves
out - a dependency, the module that binds a required port, the module behind a control - naming
each with what its module skips, and prints one manifest line that adds them all and what they
need in turn. Which module binds a port is learned only once the boot has already failed: what
the modules the boot registered bound is in its container, and every other plugin of the list
registers once, on its own, into a container that is then dropped. That is why `register()`
only declares into the registry - a timer, connection, file read, process listener, global or
`process.env` write there would run in that pass too - and a resource opens in a `provide()` or
router factory, which only the container that serves runs. A failed boot disposes its container,
closing what the boot had opened.

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
- When a manifest boot fails, every plugin of the list the boot had not registered registers
  once, to learn what it binds. A `register()` that does more than declare - logs, reads
  configuration and throws - does so in that pass. One that throws counts as binding what it
  bound before the throw, and the error names it when a required port is left without a known
  binder.

**Neutral:**

- Roll out the worker instance first, then the replicas with the exclusion; jobs enqueued in
  between wait in Redis.
- `/health` does not report the selection: it is a public contract, and the boot log is the
  record.
