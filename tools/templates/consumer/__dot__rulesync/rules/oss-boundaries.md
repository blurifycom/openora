---
root: false
targets:
  - '*'
globs:
  - '**/*'
description: OSS core is read-only; enforced import/module boundaries.
---

# OSS core + import boundaries

## Never modify OSS core

`@openora/*` is a third-party dependency - read it for reference, never write to it.

- Do NOT edit `node_modules/**` or a linked OSS checkout. Those paths are write-denied in `.claude/settings.json`; don't route around it with `sed`, redirection, or scripts. A patched dependency is lost on reinstall and diverges from the published package.
- Extend from the OUTSIDE only: overlay plugins, adapter rebindings, UI plugins, config.
- If something can only be fixed in core, STOP and report it upstream (problem, expected behavior, likely location).

## Import boundaries (enforced)

Enforced by `pnpm lint` (oxlint, per-edit), `pnpm boundaries` (dependency-cruiser, whole graph), the pre-commit hook, CI, and the agent PostToolUse hook. Fix the import, never work around a violation.

- No deep OSS imports: `@openora/*/src/*` or `/dist/*` - import only the published entrypoint or subpath export.
- No deep imports into your own shared packages - only the barrel/index entrypoint.
- No app-to-app imports (`apps/api` <-> `apps/web` <-> `apps/backoffice`) - extract shared code to `packages/*`.
- No cross-module imports inside an app - go through the module barrel, a query invalidation, or a domain event.
- No overlay-to-overlay imports - couple via a command port, a domain event, or a shared contract.
- No import cycles.

`pnpm boundaries:graph` renders the graph (needs Graphviz).
