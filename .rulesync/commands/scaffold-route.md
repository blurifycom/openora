---
targets:
  - '*'
description: 'Add an oRPC route stub to an existing module. Args: <module> <GET|POST|PUT|PATCH|DELETE> <path>. Example: /scaffold-route wallet GET /transactions'
---

Parse $ARGUMENTS as: <module> <method> <path>.

Before adding, call the MCP dev server tool `query-openapi` with the path to confirm the route doesn't already exist.

Run `pnpm gen route <module> <method> <path>` in the repo root (`pnpm scaffold route ...` still
works as an alias). The generator adds BOTH a contract procedure (to the module's
`@oss/orpc-contract` slice) and a matching router handler - no inline Zod in the router.

After the generator adds the procedure:

1. Open `packages/contracts/orpc-contract/src/<module>.ts` and replace the placeholder
   `.output(z.object({}))` with the real input/output schemas (derive from existing schemas).
2. Open `packages/modules/<module>/src/router/index.ts` and implement the handler, delegating
   to the service (admin routes call `await adminGuard.assert(context)` first).
3. Add the service method to `service/<module>.service.ts`.
4. Run `pnpm regen && pnpm verify`.
