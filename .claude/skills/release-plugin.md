---
name: release-plugin
description: Validate an overlay plugin against the definePlugin contract, build it, and optionally publish to npm. Arg: path to the plugin directory (e.g. apps/api/src/extensions/my-plugin).
---

Given the plugin path from $ARGUMENTS:

1. Read the `plugin.ts` to verify it exports `default definePlugin({ id, register })`.
2. Run `pnpm verify --filter <plugin-package-name>` to confirm types and tests pass.
3. Check that `AGENTS.md` exists and is filled in (not just the template).
4. Run `pnpm -F <plugin-package-name> build` to confirm it builds.
5. Ask the user if they want to publish to npm. If yes, run `pnpm -F <plugin-package-name> publish --access public`.
6. Report the result.
