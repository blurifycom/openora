# anti-slop (vendored)

Oxlint rules that reject low-evidence TypeScript patterns, vendored from [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop) under the MIT licence in `LICENSE`. The files here are ours to maintain: change a rule when our standards call for it, and record the change below.

- Upstream commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`
- Tested against `oxlint` and `@oxlint/plugins` 1.78.0, pinned together in the root `package.json`.
- The Effect rule group is not vendored; openora does not depend on Effect.
- Registered in `.oxlintrc.json` as the `anti-slop` JS plugin; rule tests run in `pnpm test:tools`.

## Local changes

- Added `package.json` with `"type": "module"` so Node loads the rule files as ES modules without a reparse warning. It is not a workspace package.
