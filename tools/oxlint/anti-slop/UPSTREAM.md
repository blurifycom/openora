# anti-slop upstream

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. The installed `install-anti-slop` skill was compared byte for byte with `skills/install-anti-slop` at this commit, and its `assets/anti-slop` is what the skill's `scripts/install.mjs` copied here.
- Installed with the `install-anti-slop` skill (`npx skills add dmmulroy/anti-slop --skill install-anti-slop`). Update through the same skill, which merges upstream changes and keeps the deviations below.
- Installed paths: `tools/oxlint/anti-slop/` (generic plugin at `index.ts`, Effect plugin at `effect/index.ts`).
- Dependencies: `oxlint` and `@oxlint/plugins` pinned together at 1.78.0 in the root `package.json`.

## Intentional deviations

- Rules start at `warn` and move to `error` in the pull request that clears their remaining sites, instead of every rule at `error` on install. Rules the codebase already satisfies are `error` from the start. See `docs/standards/enforcement.md`.
- The Effect plugin is copied but not registered: openora has no direct `effect` dependency.
- `LICENSE` is added from the upstream repository root, because the skill bundle does not carry the MIT notice for the plugin itself.
