---
targets:
  - '*'
description: 'Add an oRPC route stub to an existing add-on. Args: <add-on> <GET|POST|PUT|PATCH|DELETE> <path>. Example: /scaffold-route wallet GET /transactions'
---

Parse $ARGUMENTS as: <add-on> <method> <path>.

Before adding, call the MCP dev server tool `query-openapi` with the path to confirm the route doesn't already exist.

Run `pnpm gen route <add-on> <method> <path>` in the repo root. The generator adds BOTH a contract procedure (to the add-on's
`@oss/orpc-contract` slice if core, or `src/contract/` if gated) and a matching router handler - no inline Zod in the router.

After the generator adds the procedure:

1. Open `packages/contracts/orpc-contract/src/<add-on>.ts` (for core add-ons) and replace the placeholder
   `.output(z.object({}))` with the real input/output schemas (derive from existing schemas).
2. Open `packages/addons/<add-on>/src/router/index.ts` and implement the handler, delegating
   to the service (admin routes call `await adminGuard.assert(context)` first).
3. Add the service method to `service/<add-on>.service.ts`.
4. Run `pnpm regen && pnpm verify`.
