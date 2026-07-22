---
'@openora/core': patch
'@openora/create': patch
---

fix: scaffolded consumer boots the full platform out of the box

Two boot blockers in a freshly scaffolded app are fixed:

- `corePlugins()` was missing `tag`, `player-note`, and `player-management`. Because
  `compliance` declares `dependsOn: ['player-management', ...]`, a consumer that composed
  its registry from `corePlugins()` crashed at boot with `Plugin "compliance" depends on
"player-management" which is not registered`. The helper now mirrors the full default
  registry.
- The scaffold's `docker-compose.yml` started only Postgres, but `createApp` is
  distributed-only (ADR-0030) and refuses to boot until the durable seams are bound from
  `REDIS_URL`. `docker compose up -d` now also starts Redis, and `.env.example` documents
  it as required.
