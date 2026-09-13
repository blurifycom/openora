---
targets:
  - '*'
description: 'Run the full pre-PR gate locally - `pnpm verify`, which ends with the drift check CI enforces. Catches a stale generated catalog table before push.'
---

Run the same gate CI enforces. Stop at the first failure and report it.

`pnpm verify` - build, lint, format, boundaries, module shape, hygiene, deprecations, unit tests, integration tests, tool tests, and finally `pnpm check:drift`. The drift step is the last link in the `verify` chain, so running it separately afterwards repeats work that already ran.

`check:drift` verifies tsconfig paths are in sync and fails on an uncommitted diff to the generated table in `docs/platform/system-design.md`. `docs/catalog.json` is gitignored and regenerated on install, so it cannot drift.

The rulesync-generated agent files (AGENTS.md, CLAUDE.md, .codex/config.toml, Copilot mirrors) are gitignored and regenerated from `.rulesync/` on `pnpm install` - they can't drift, so there's nothing to check. If you changed agent instructions, edit `.rulesync/` and run `pnpm gen:agents`.

After running:

- All green: report ready for PR, list the changed files (`git diff origin/dev...HEAD --name-only`).
- A `verify` step fails: show the failing step (build / lint / format / boundaries / shape / hygiene / deprecations / tests) with location, propose a fix.
- `check:drift` fails: the generated table is stale - run `pnpm regen`, then re-run the gate.

Never report ready for PR if the gate fails.
