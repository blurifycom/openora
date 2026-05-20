---
name: scaffold-module
description: Generate a new OSS module from template. Creates all required files (schemas, service, router, prisma partial, UI stub, plugin.ts, AGENTS.md) and registers in extensions.config.ts.
---

Run `pnpm scaffold module $ARGUMENTS` in the repo root.

After the scaffolder finishes:

1. Open `packages/modules/<name>/src/plugin.ts` and verify the module ID.
2. Open `packages/modules/<name>/prisma.partial.prisma` and define the tables.
3. Open `packages/modules/<name>/src/service/<name>.service.ts` and sketch the business logic.
4. Open `packages/modules/<name>/src/router/index.ts` and add the oRPC routes.
5. Run `pnpm regen` to merge Prisma schemas and regenerate the client.
6. Run `pnpm verify --filter @oss/module-<name>` to check types and tests.

Tell the user what was generated and what they need to fill in next.
