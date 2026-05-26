---
name: scaffold-route
description: Add an oRPC route stub to an existing module. Args: <module> <GET|POST|PUT|PATCH|DELETE> <path>. Example: /scaffold-route wallet GET /transactions
---

Parse $ARGUMENTS as: <module> <method> <path>.

Before adding, call the MCP dev server tool `query-openapi` with the path to confirm the route doesn't already exist.

Run `pnpm scaffold route <module> <method> <path>` in the repo root.

After the scaffolder adds the stub:

1. Open `packages/modules/<module>/src/router/index.ts` and define the Zod input/output schemas (import from `schemas/` or `@oss/contracts/shared-schemas`).
2. Implement the handler body delegating to the service.
3. Add the service method to `service/<module>.service.ts`.
4. Run `pnpm regen && pnpm verify --filter @oss/module-<module>`.
