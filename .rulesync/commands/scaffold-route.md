---
targets:
  - '*'
description: 'Add an oRPC route stub to an existing module. Args: <domain> <module> <GET|POST|PUT|PATCH|DELETE> <path>. Example: /scaffold-route engagement chat GET /rooms'
---

Parse $ARGUMENTS as: <domain> <module> <method> <path>. The domain is the module's dir under `packages/core/src/`.

Before adding, call the MCP tool `query-openapi` with the path to confirm the route doesn't already exist.

Run `pnpm gen route <domain> <module> <method> <path>` in the repo root. The generator adds BOTH a contract procedure (in the module's `contract/index.ts`) and a matching router handler - no inline Zod in the router.

Then:

1. In the module's `contract/index.ts`, replace the placeholder `.output(z.object({}))` with real input/output schemas (derive from existing schemas - `.pick/.omit/.extend`, don't re-type).
2. In `router/index.ts`, implement the handler, delegating to the service. Admin routes call `await adminGuard.assert(context)` first.
3. Add the service method in `service/<module>.service.ts`. Audit any state-changing action (domain event or `AUDIT_WRITER`).
4. `pnpm regen && pnpm verify`.
