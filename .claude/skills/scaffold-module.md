---
name: scaffold-module
description: Generate a new OSS module from template. Creates all required files (schemas, service, router, prisma partial, UI stub, plugin.ts, AGENTS.md) and registers in extensions.config.ts.
---

Run `pnpm scaffold module $ARGUMENTS` in the repo root. Modules are grouped, so
the args are `<group> <name>` where group is `player`, `backoffice`, or `platform`
(player-facing / admin / shared substrate). Example: `pnpm scaffold module player tournaments`.

After the scaffolder finishes (module lands at `packages/modules/<group>/<name>/`):

1. Open `<group>/<name>/src/plugin.ts` and verify the module ID.
2. Open `<group>/<name>/prisma.partial.prisma` and define the tables.
3. Open `<group>/<name>/src/service/<name>.service.ts` and sketch the business logic.
4. Open `<group>/<name>/src/router/index.ts` and add the oRPC routes.
5. Run `pnpm regen` to merge Prisma schemas and regenerate the client.
6. Run `pnpm verify --filter @oss/module-<name>` to check types and tests.

Tell the user what was generated and what they need to fill in next.
