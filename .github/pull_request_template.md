## Summary

<!-- 1-2 sentences: what changes, then why it matters / what it covers. Bare ticket key(s), no URLs. -->

## Changes

<!-- A bullet per module/area - a map for the reviewer, not a re-listing of the diff. New module/plugin/adapter? New routes or tables? -->

-

## Acceptance criteria

<!-- Copy from the ticket; tick what this PR satisfies. Delete if not ticket-driven. -->

- [ ]

## Checklist

- [ ] `pnpm verify` is green (typecheck + lint + boundaries + module-shape + tests)
- [ ] `pnpm verify:drift` is green (catalog / OpenAPI not stale) - run `pnpm regen` if not
- [ ] New cross-module talk goes through events / command ports / contracts / the `/schema` subpath (no direct module imports)
- [ ] New data tables carry `tenantId` and are RLS-covered (`pnpm regen` runs `gen:rls`)
- [ ] No secrets, real player data, or internal/customer names added
- [ ] Docs / AGENTS.md updated if behavior or extension points changed

## Notes

<!-- Deferred / out-of-scope work, breaking changes, follow-ups. Delete if none. -->

Closes ANPI-XXX / BF-XXX
