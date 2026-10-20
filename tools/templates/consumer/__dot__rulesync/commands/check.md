---
targets:
  - '*'
description: Run the fast local gate - typecheck + lint + unit tests. Use `pnpm verify` for the full pre-MR gate (adds format check, boundaries, build).
---

Run in order, stop at the first failure:

1. `pnpm check:types`
2. `pnpm check:lint`
3. `pnpm test:unit`

`pnpm verify` is the pre-MR gate: these three plus whatever else the repo wires into that script (format, boundaries, build). It also records the verified commit, which the `guard-mr` hook checks before an MR/PR is opened.

After running:

- All green: report ready; list changed files (`git diff --name-only`).
- A step fails: show the exact location, propose a fix. Never report ready while any step is red.

Agent files (`AGENTS.md`, `CLAUDE.md`, mirrors) are gitignored and generated from `.rulesync/` on install - nothing to drift-check. If you changed agent instructions, edit `.rulesync/` and run `pnpm gen:agents`.

Do not touch `@openora/*` core or `node_modules` - this repo extends the platform from the outside only (overlay plugins, adapter rebindings, UI plugins, config).
