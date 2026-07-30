# Git and delivery

Detail for the delivery lines in `conventions`. Read this before committing, opening a PR, or writing a commit message.

- **Conventional commits, enforced** (commitlint on commit + CI). Types: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `ci`, `perf`. The scope is a workspace-derived `scope-enum` (module dirs, apps, plus `ci`/`deps`/`rules`/`repo`/`tooling`); an unlisted scope fails - check with `pnpm commitlint --from HEAD~1` or omit the scope. `feat(wallet): atomic debit command port`
- **Subject must start lowercase** (`subject-case`), acronyms included - write `feat(pam): kyc status filter`, not `KYC`. This applies to the **PR title too**: squash-merge derives the `dev` commit message from the PR title, which local commit hooks never lint - an uppercase title lands a failing commit on `dev`.
- **One PR = one concern.** Stage files explicitly; never `git add -A` with foreign changes in the tree.
- **Green before review:** `pnpm verify` passes; `pnpm regen` after any contract/schema change.
- **Branch off `dev`; never commit directly to `dev`/`stage`.** Promotion chain `dev -> stage` + release tags. Never push without an explicit per-action confirmation.
- **PR description carries intent:** what / why / acceptance criteria / ticket key.
- **No sensitive/internal data in titles, descriptions, or commits** - they are the public record. Bare ticket key (`ABC-45`), never the URL; no internal links, hostnames, secrets, PII. When in doubt, leave it out.
