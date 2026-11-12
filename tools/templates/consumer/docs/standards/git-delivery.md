# Git and delivery

Read this before a commit, PR, or branch operation.

- Conventional commits, enforced by commitlint (husky locally, CI on the PR/MR title): `feat`, `fix`, `refactor`, `chore`,
  `docs`, `test`, `ci`, `perf`. E.g. `feat(wallet): atomic debit command port`.
- Subject starts lowercase, acronyms included (`feat(pam): kyc status filter`). This applies to
  the PR title too - squash merges derive the commit message from it.
- One PR = one concern. Stage files explicitly; never `git add -A` when foreign changes are in
  the tree.
- Green before review: `pnpm verify` on the committed tree. It is the full gate and records the
  verified commit; the `guard-mr` hook blocks opening the PR/MR without it.
- Reviewed before it leaves the machine: an agent runs `ship`, or the `review` skill until
  APPROVED, before every push, including a branch already in review and a push after a rebase or
  a pipeline fix. The `guard-review` hook blocks a push or a new PR/MR until a review approved
  that exact HEAD; a promotion from a shared branch, a branch delete, and a tag push pass.
- On GitHub, a PR that builds on another feature branch goes up as a native stacked PR with
  `gh stack` (`init`, `add`, `submit`, `sync`); the `guard-stack` hook blocks a plain PR based on
  a feature branch. Each layer is reviewed on its own.
- Branch off `dev`; never commit directly to a shared branch; never push without an explicit
  per-action "yes push", except the ticket branch `/ship` opens its MR from.
- PR description carries intent: what / why / acceptance criteria / ticket link. No secrets,
  internal hostnames, or PII - it is the public record.
- A PR that adds or changes a flow across components (request path, state machine, async job or
  webhook, a new module, overlay or vendor binding) carries a Mermaid `flowchart` or
  `sequenceDiagram` of it: nodes named as in the code, under ~15 nodes, refusal and failure
  branches included. No flow, no diagram.
