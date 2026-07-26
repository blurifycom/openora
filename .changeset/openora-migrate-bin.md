---
'@openora/core': minor
---

Ship an `openora-migrate` bin with `@openora/core`. It derives the migration sets from the
package's own `exports` map (every `*/migrate*` subpath, engine first) instead of a hand-kept
list, so a consumer never drifts when core adds or removes a module. It resolves the nearest
`.env` walking up from the working directory, so it runs from a repo root or an app dir alike.

Replaces the hand-maintained runners on both sides: `tools/db/migrate-all.mjs` here, and
`apps/api/src/migrate.ts` in the scaffolded consumer template (its root `db:migrate` now calls
the bin).
