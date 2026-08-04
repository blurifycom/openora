---
targets:
  - '*'
description: 'Validate an overlay plugin against the definePlugin contract, build it, and optionally publish to npm. Arg: path to the plugin directory (eg extensions/my-plugin).'
---

Given the plugin path from $ARGUMENTS:

1. Read `plugin.ts` - it must export `definePlugin({ id, register })`.
2. `pnpm verify --filter <plugin-package-name>` - types and tests pass.
3. `pnpm -F <plugin-package-name> build`.
4. Ask the user before publishing; on yes: `pnpm -F <plugin-package-name> publish --access public`.
5. Report the result.
