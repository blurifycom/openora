---
root: true
targets:
  - '*'
globs:
  - '**/*'
---

# AGENTS.md

Canonical brief for AI agents and humans. Per-tool files are generated from `.rulesync/`; edit the source, then run `pnpm gen:agents`. Never hand-edit generated mirrors.

## Mission

Open-source, headless, plugin-based, AI-native igaming framework. Consumers extend modules, plugins, and adapters in their own repo; this repository ships backend contracts, runtime, SDK, tooling, and no consumer UI.

## Load the right owner

- Universal engineering baseline and a topical routing table: `conventions`.
- Events, jobs, realtime, and outbox choices: `messaging-and-microservices`.
- Module boundaries, DI, ports, and shared helpers: `docs/standards/module-structure.md`.
- Money, compliance, and audit: read `docs/standards/{money,compliance,audit}.md` before changing those paths.
- The touched module's contract, schema, plugin, and catalog entry define its current surface. There are no nested module instructions.

## Quick destinations

- New module, route, table, seed, schema, enum, adapter, config, hook, or integration: use the matching generator and the topical standard named by `conventions`.
- Cross-module work: use a command port, domain event, shared contract, or read-only `/schema` subpath as defined in `docs/standards/module-structure.md`.
- Async or cross-process work: choose the channel in `messaging-and-microservices` before implementation.
- Docs or generated configuration: edit canonical source only. `pnpm regen` owns generated artifacts; `pnpm gen:agents` owns agent mirrors.

## Root guardrails

- Headless means no frontend UI belongs here; consumers build over `@openora/core/react`.
- Admin routes resolve the shared `AdminGuard` in `plugin.ts`; `await adminGuard.assert(context)` is the handler's first line.
- Serialize `pnpm regen` and `pnpm gen:agents` across agents. They rewrite shared generated state; one owner runs each command after parallel edits finish.
- Delegate a task to the matching named roster agent when one exists; do not use a generic agent for a roster task.
