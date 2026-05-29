---
name: regen
description: Regenerate all derived artifacts - oRPC OpenAPI spec, Drizzle client, and the machine-readable docs/CATALOG.md. Run after any change to Drizzle tables or oRPC contracts.
---

Run `pnpm regen` in the repo root.

This runs in order (see root `package.json`):

1. `turbo run codegen` - emits `docs/openapi.json` from the composed oRPC contract and
   regenerates any per-package codegen registered with turbo.
2. `pnpm -F @oss/db generate` - regenerates the Drizzle client from the live schema files
   under `packages/modules/<group>/<name>/src/schema/index.ts`.
3. `pnpm run gen:catalog` (`tsx tools/gen-catalog.ts`) - emits `docs/CATALOG.md`: the
   machine-readable surface listing routes / schemas / adapters / slots / events. The MCP
   dev server and AI catalogs read from this file.

`regen` does NOT create a migration. After it succeeds and you've changed table shape,
generate a real migration:

```bash
pnpm -F @oss/db exec drizzle-kit generate --name <change-summary>
```

Ship the migration file - downstream consumers run it too. Never hand-edit a migration under
`packages/platform/db/`; rerun `drizzle-kit generate` instead.

Watch for:

- `verify:drift` failures in CI - means `regen` was not run after a schema or contract change.
- Type errors in the API after regen - usually a route's output schema no longer matches the model.
- Boundary lint errors - module imported another module directly instead of via the
  `@oss/modules/<group>/<name>/schema` subpath or an event.

Report what changed and whether any follow-up is needed.
