## Summary

<!-- What changed, in 1-2 sentences. Bare ticket key, no URLs. -->

## Why

<!-- Introduced these changes because ... - the problem behind them, or what the ticket asked for. -->

## Worth knowing

<!-- Risk, breaking changes, deferred / out-of-scope work, where to start reviewing. Delete if none. -->

- [ ] `pnpm verify` is green (typecheck + lint + boundaries + module-shape + tests)
- [ ] `pnpm check:drift` is green (catalog / OpenAPI not stale) - run `pnpm regen` if not
- [ ] New cross-module talk goes through events / command ports / contracts / the `/schema` subpath (no direct module imports)
- [ ] New data tables carry `tenantId` and are RLS-covered (`pnpm regen` runs `gen:rls`)
- [ ] No secrets, real player data, or internal/customer names added

Closes ANPI-XXX / BF-XXX
