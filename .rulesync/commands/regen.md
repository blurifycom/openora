---
targets:
  - '*'
description: 'Regenerate all derived artifacts - oRPC OpenAPI spec, Drizzle client, and the machine-readable docs/catalog.json. Run after any change to Drizzle tables or oRPC contracts.'
---

Run `pnpm regen` in the repo root.

This runs in order (see root `package.json`):

1. `turbo run codegen` - emits `docs/openapi.json` from the composed oRPC contract and
   regenerates any per-package codegen registered with turbo.
2. `pnpm -F @blurifycom/core generate` (`scripts/generate-all.mjs`) - discovers every module's
   `src/**/drizzle.config.ts` and runs `drizzle-kit generate` per module, against that module's own
   co-located `drizzle/migrations/` history (ADR-0027).
3. `pnpm run gen:catalog` (`tsx tools/gen-catalog.ts`) - emits `docs/catalog.json`: the
   machine-readable surface listing routes / schemas / adapters / slots / events. The MCP
   dev server and AI catalogs read from this file.

`regen` does NOT create a migration. After it succeeds and you've changed table shape,
generate a real migration:

```bash
# all modules at once
pnpm -F @blurifycom/core generate
# or one module (cwd = the module dir holding its drizzle.config.ts)
cd packages/core/src/<domain>/<module> && pnpm exec drizzle-kit generate --name <change-summary>
```

Ship the migration file - downstream consumers run it too. Never hand-edit a migration under a module's
`drizzle/migrations/`; rerun `drizzle-kit generate` instead.

Watch for:

- `verify:drift` failures in CI - means `regen` was not run after a schema or contract change.
- Type errors in the API after regen - usually a route's output schema no longer matches the model.
- Boundary lint errors - add-on imported another add-on directly instead of via the
  `@blurifycom-addons/<name>/schema` subpath or an event.

Report what changed and whether any follow-up is needed.
