# ADR-0044: Opt-out anonymous usage telemetry

**Date**: 2026-10-12
**Status**: Accepted

## Context

We have no idea how many deployments run Openora, which versions they're on, or whether they
have players. npm download counts mix CI installs, mirrors and bots, and say nothing about a
server that keeps running. We want a count of active installs that respects operators: no
personal data, visible, and easy to switch off.

## Decision

The server sends a small anonymous report to an Umami collector at `telemetry.openora.ai`, on
start (at most hourly per deployment, guarded by a Redis key) and daily through a `JOB_QUEUE`
scheduler. The scaffolder sends one report per project created. What each report holds, and
every way to turn it off, is in [usage telemetry](../platform/telemetry.md).

- **On by default, opt-out.** An opt-in count only measures the people who read the docs. The
  switch is an env var, the `DO_NOT_TRACK` standard, or a `createApp` option, and the server logs
  how to use it at boot.
- **The instance id lives in Postgres**, in a single-row engine table next to the outbox.
  Replicas racing on first boot converge on one id. Redis was rejected: a flush would mint a new
  id and inflate the count.
- **Player counts go through the activity tracker port**, so the runtime never reads the player
  table, and a deployment without the player module reports empty counts.
- **The Umami event format, not a custom collector.** The maintainers already run Umami, and its
  distinct id makes "unique visitors" equal active installs. The hostname is dedicated so a
  released version keeps a working URL whatever runs behind it.
- **No install hook.** Scanners flag postinstall scripts, pnpm 10 blocks them, and CI installs
  would swamp the count.

## Consequences

- A public client can't authenticate, so anyone can post fake reports. Rate limits and a body cap
  sit at the edge in front of the collector, and the counts are treated as approximate.
- A failed report is dropped with a warning; nothing retries, and boot never waits on it.
- Changing what a report carries means updating the usage telemetry page in the same change.
- The scaffolder copies the payload and opt-out rules instead of importing the core runtime; the
  two are kept in step by hand.
