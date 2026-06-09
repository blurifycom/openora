---
targets:
  - '*'
description: "Run the full pre-PR gate locally - `pnpm verify` plus the drift check CI runs (`pnpm verify:drift`), which `pnpm verify` alone does NOT cover. Catches stale catalog/openapi/agent-docs before push."
---
Run the same gate CI enforces, in order. Stop at the first failure and report it.

1. `pnpm verify` - typecheck + unit tests + lint + module shape.
2. `pnpm verify:drift` - regenerates the catalog and fails on an uncommitted diff to `docs/catalog.json` / `docs/CATALOG.md`.

The rulesync-generated agent files (AGENTS.md, CLAUDE.md, .codex/config.toml, Copilot mirrors) are gitignored and regenerated from `.rulesync/` on `pnpm install` - they can't drift, so there's nothing to check. If you changed agent instructions, edit `.rulesync/` and run `pnpm sync:agents`.

After running:

- All green: report ready for PR, list the changed files (`git diff main...HEAD --name-only`).
- `verify` fails: show the failing step (typecheck / test / lint / shape) with location, propose a fix.
- `verify:drift` fails: the catalog is stale - run `pnpm regen`, then re-run the gate.

Never report ready for PR if either step fails.
