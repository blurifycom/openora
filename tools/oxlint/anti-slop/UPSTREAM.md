# anti-slop upstream

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b`. The installed `install-anti-slop` skill was compared byte for byte with `skills/install-anti-slop` at this commit, and its `assets/anti-slop` is what the skill's `scripts/install.mjs` copied here.
- Installed with the `install-anti-slop` skill (`npx skills add dmmulroy/anti-slop --skill install-anti-slop`). Update through the same skill, which merges upstream changes and keeps the deviations below.
- Installed path: `tools/oxlint/anti-slop/`, registered from `index.ts`.
- Dependencies: `oxlint` and `@oxlint/plugins` pinned together at 1.78.0 in the root `package.json`.

Upstream is explicit that this is "meant to be vendored, not treated as a fixed npm dependency", and that its rules are one engineer's preferences rather than a universal standard. So the vendored copy is a subset, not a mirror: a rule is kept only where it mechanically enforces something this repo already writes down.

## What is kept, and which standard each rule enforces

| Rule | Enforces |
| ---- | -------- |
| `no-unknown-parameters` | `types.md` - "`unknown` + narrowing, or the real type" |
| `no-unknown-returns` | same |
| `no-unknown-type-aliases` | same |
| `no-unsafe-dictionary-type` | same |
| `no-chained-type-assertions` | `types.md` - "`as unknown as X` turns type-checking off entirely" |
| `no-widen-then-assert` | same |
| `no-known-value-widening` | same |
| `require-safety-comment-for-type-assertion` | `types.md` - a sanctioned cast carries a one-line boundary note |
| `no-runtime-typeof` | schema-first parsing at trust boundaries |
| `no-module-mocking` | `testing.md` - never an in-process test that mocks the database, a repository, or a sibling service; ADR-0039 |

## Intentional deviations

- **Eight generic rules removed**, because no standard here asks for them and each was costing more than it caught: `no-array-filter-map` and `no-reduce-accumulator-copy` (micro-optimisation), `no-object-parameters`, `no-shape-in-symbol-names` (naming taste), `no-reflect-apply` and `no-reflect-get` (this repo does not use `Reflect`), `no-conditional-empty-object-spread` (readability taste), and `require-readable-spacing` (formatting is oxfmt's job, and the rule carried a 1,094-line vendored copy of eslint-stylistic's `padding-line-between-statements`). `shared/array-method.ts` and `shared/reflect-method.ts` went with them, as did `vendor/`.
- **The Effect plugin is deleted**, not merely unregistered: openora has no direct `effect` dependency, so it was 358 lines that could never run.
- Rules start at `warn` and move to `error` in the pull request that clears their remaining sites, instead of every rule at `error` on install. Rules the codebase already satisfies are `error` from the start. See `docs/standards/enforcement.md`.
- `LICENSE` is added from the upstream repository root, because the skill bundle does not carry the MIT notice for the plugin itself.

A re-run of `install-anti-slop` will try to restore the removed rules and the Effect plugin. Re-apply this ledger after any upstream merge: keep the ten above, drop the rest.

## Not to be confused with

`miqdadbadjuber/anti-slop` is an unrelated project with the same name. It ships agent skills that filter AI-sounding UI, copy, accessibility and layout - no lint rules, no CI gate. It has nothing to enforce in a headless backend that ships no UI; it belongs in a consumer repo, not here.
