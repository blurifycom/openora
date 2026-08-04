# Git and delivery

Read this before a commit, PR, or branch operation.

- Conventional commits, enforced by commitlint (husky + CI): `feat`, `fix`, `refactor`, `chore`,
  `docs`, `test`, `ci`, `perf`. E.g. `feat(wallet): atomic debit command port`.
- Subject starts lowercase, acronyms included (`feat(pam): kyc status filter`). This applies to
  the PR title too - squash merges derive the commit message from it.
- One PR = one concern. Stage files explicitly; never `git add -A` when foreign changes are in
  the tree.
- Green before review: typecheck + lint + unit tests pass; `pnpm verify` is the full gate (adds
  format:check + boundaries + build).
- Branch off `dev`; never commit directly to a shared branch; never push without an explicit
  per-action "yes push".
- PR description carries intent: what / why / acceptance criteria / ticket link. No secrets,
  internal hostnames, or PII - it is the public record.
