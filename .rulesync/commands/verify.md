---
targets:
  - '*'
description: 'Run full verification - typecheck, lint, unit tests. Equivalent to what CI runs. Optional filter: /verify --filter @openora/core'
---

Parse $ARGUMENTS for an optional `--filter <package>` flag.

If filter provided, run: `pnpm verify --filter <package>`
Otherwise run: `pnpm verify`

This executes `turbo run build check:lint check:format check:boundaries check:shape check:hygiene
check:deprecations test:unit test:integration test:tools`, then `pnpm check:drift` (or scoped to the
filter). `build` is what typechecks - see `docs/standards/enforcement.md`.

After completion:

- If all pass: report green, suggest next steps.
- If typecheck fails: show the error location and propose a fix.
- If lint fails: show the rule violation and fix it.
- If tests fail: show the failing test and either fix or explain why the test needs updating.

Never mark a task complete if verify fails.
