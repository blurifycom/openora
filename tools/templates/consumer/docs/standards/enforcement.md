# Enforcement

Read this before working around a failing gate or adding a lint rule.

- `pnpm check:types` + `pnpm check:lint` (oxlint) + `pnpm test:unit` is the fast gate;
  `pnpm check:boundaries` (dependency-cruiser) is the whole-graph boundary/cycle check, also run
  by the pre-commit hook and CI.
- oxlint extends the platform's shared config (`./node_modules/@openora/core/oxlint/oxlintrc.json`)
  - add local rules on top, never fork it.
- Don't work around a lint/boundary violation - fix the import.
- Agent rules are generated from `.rulesync/` via `pnpm gen:agents` - never hand-edit a generated
  file.
