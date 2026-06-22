# ADR-0015: Boundary lint stays a hand-written oxlint plugin (not eslint-plugin-boundaries)

**Date**: 2026-05-29
**Status**: Accepted
**Relates to**: the dependency rules in AGENTS.md and `tools/oxlint-boundaries-plugin.mjs`

> **Update (2026-06-10)**: The oxlint plugin remains the fast per-edit, specifier-string enforcer. A second, complementary whole-graph gate was added - `.dependency-cruiser.cjs` (dependency-cruiser), run via `pnpm boundaries` (in `pnpm verify`, the pre-commit hook, and CI). It runs on the RESOLVED dependency graph, so it catches what specifier-string matching cannot: transitive edges, re-export/barrel laundering, dynamic `import()`, relative paths that dodge the `@blurifycom/` prefix, and import cycles (`no-circular`). It does NOT replace the oxlint plugin; the two are kept in sync (a rule in one should have a twin in the other). This is the "resolved-file relationships" need anticipated in Consequences below - met with dependency-cruiser, not `eslint-plugin-boundaries`.

## Context

A reviewer noted that `eslint-plugin-boundaries` "has no oxlint equivalent" and suggested the architecture boundaries should be enforced by it. The repo already enforces them with a hand-written oxlint JS plugin (`tools/oxlint-boundaries-plugin.mjs`, loaded via `jsPlugins`). We spiked whether to replace it with the real `eslint-plugin-boundaries`.

## Findings (spike)

- oxlint (1.66) **can** load `eslint-plugin-boundaries@6` as a `jsPlugin`; its `settings` (`boundaries/elements`) are honored. So "no oxlint equivalent" is not true - the premise is moot.
- `eslint-plugin-boundaries` enforces nothing unless each `@blurifycom/*` import **resolves to a file** (it classifies the resolved file against element patterns). Source-glob-only rules without a resolver are silent.
- pnpm resolves `@blurifycom/*` to `dist/`, which misclassifies elements. Correct classification needs:
  - the native `eslint-import-resolver-typescript` (`unrs-resolver` binary), and
  - a maintained **lint-only tsconfig** mapping all ~24 `@blurifycom/*` packages to `src` (drift risk on every new package),
  - plus re-expressing every rule + the `/schema`, barrel, deep-`dist`, and cross-extension exceptions in boundaries config, and a slower lint pass.

The custom plugin matches **specifier strings** directly: zero deps, zero resolution, fast, and already green across the repo.

## Decision

Keep the hand-written oxlint boundary plugin. Do **not** adopt `eslint-plugin-boundaries`. The barrel/entry-point concern (a module's public API is its root entry + `/schema` only) is covered by a new rule in the same plugin: `no-module-internal-import`.

Enforced rules: `no-cross-module-import`, `no-module-internal-import`, `no-platform-to-module`, `no-contracts-to-runtime`, `no-deep-dist-import`, `no-sdk-layer-inversion`, `no-cross-extension-import`.

## Consequences

- No native lint dependency, no parallel path-map tsconfig to keep in sync, fast lint.
- `eslint-plugin-boundaries` remains a documented, validated fallback if the rule set ever outgrows specifier-string matching (e.g. needs `captured`-value relationships across resolved files).
- The decision and its rationale live in the plugin header comment so it is not re-litigated.

## Alternatives considered

| Option                                                                     | Verdict                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Hand-written oxlint plugin (specifier-string matching)                     | **chosen**                                                                      |
| Full migration to `eslint-plugin-boundaries` + TS resolver + lint tsconfig | rejected - native dep + maintained path map + slower lint for no added coverage |
| Hybrid (boundaries for some rules, custom for the rest)                    | rejected - two overlapping mechanisms, more config surface                      |
