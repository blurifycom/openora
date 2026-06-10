## What & why

<!-- What does this change and what problem does it solve? Link the issue/ADR. -->

## How

<!-- Key implementation notes. New module/plugin/adapter? New routes or tables? -->

## Checklist

- [ ] `pnpm verify` is green (typecheck + lint + boundaries + module-shape + tests)
- [ ] `pnpm verify:drift` is green (catalog / OpenAPI not stale) - run `pnpm regen` if not
- [ ] New cross-module talk goes through events / command ports / contracts / the `/schema` subpath (no direct module imports)
- [ ] New data tables carry `tenantId` and are RLS-covered (`pnpm regen` runs `gen:rls`)
- [ ] No secrets, real player data, or internal/customer names added
- [ ] Docs / AGENTS.md updated if behavior or extension points changed
