---
targets:
  - '*'
description: Run the local gate before a PR - typecheck + lint. There is no single `verify` script in this repo; this is it.
---

This repo has no `verify` script - typecheck and lint are separate. Run them in order and stop at the first failure.

1. `pnpm typecheck` - `turbo run typecheck` across all apps.
2. `pnpm lint` - `oxlint .`.

If you have added a test runner (eg `vitest`), also run your test script.

The generated agent files (AGENTS.md, CLAUDE.md, .codex/config.toml, Copilot mirrors) are gitignored and regenerated from `.rulesync/` on `pnpm install` - there is nothing to drift-check. If you changed agent instructions, edit `.rulesync/` and run `pnpm sync:agents`.

After running:

- All green: report ready for PR; list changed files (`git diff --name-only`).
- typecheck/lint fails: show the location, propose a fix.

Do not touch `@blurifycom/*` core or `node_modules` - this repo extends the platform from the outside only (overlay plugins, adapter rebindings, UI plugins, config). Never report ready for PR if any step fails.
