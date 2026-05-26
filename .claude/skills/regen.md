---
name: regen
description: Regenerate all derived artifacts - Prisma schema merge, Prisma client, OpenAPI spec, and SDK types. Run after any change to *.partial.prisma files or oRPC contracts.
---

Run `pnpm regen` in the repo root.

This runs in order:

1. `prisma-merge` - merges all `*.partial.prisma` files into `packages/platform/db/prisma/schema.prisma`.
2. `prisma generate` - regenerates the Prisma client.
3. `turbo run codegen` - emits `docs/openapi.json` and regenerates the REST SDK if configured.

`regen` does NOT create a migration. After it succeeds and you've changed table shape, generate a real migration:

```bash
pnpm -F @oss/db exec prisma migrate dev --name <change-summary>
```

Ship the migration file - don't rely on `prisma db push` (that's dev-only convenience used by the Consumer setup script). Downstream consumers merge their own partials too, so migrations must be reproducible.

Watch for:

- Merge conflicts in the Prisma schema (table name collisions between modules).
- Type errors in the API after regeneration (usually means a route's output schema no longer matches the model).

Report what changed and whether any follow-up is needed.
