# ADR-0015: Boundary lint stays a hand-written oxlint plugin (not eslint-plugin-boundaries)

**Date**: 2026-05-29
**Status**: Accepted
**Relates to**: the dependency rules in AGENTS.md and `tools/oxlint-boundaries-plugin.mjs`

## Context

A reviewer noted that `eslint-plugin-boundaries` "has no oxlint equivalent" and suggested the architecture boundaries should be enforced by it. The repo already enforces them with a hand-written oxlint JS plugin (`tools/oxlint-boundaries-plugin.mjs`, loaded via `jsPlugins`). We spiked whether to replace it with the real `eslint-plugin-boundaries`.

## Findings (spike)

- oxlint (1.66) **can** load `eslint-plugin-boundaries@6` as a `jsPlugin`; its `settings` (`boundaries/elements`) are honored. So "no oxlint equivalent" is not true - the premise is moot.
- `eslint-plugin-boundaries` enforces nothing unless each `@oss/*` import **resolves to a file** (it classifies the resolved file against element patterns). Source-glob-only rules without a resolver are silent.
- pnpm resolves `@oss/*` to `dist/`, which misclassifies elements. Correct classification needs:
  - the native `eslint-import-resolver-typescript` (`unrs-resolver` binary), and
  - a maintained **lint-only tsconfig** mapping all ~24 `@oss/*` packages to `src` (drift risk on every new package),
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

| Option | Verdict |
|---|---|
| Hand-written oxlint plugin (specifier-string matching) | **chosen** |
| Full migration to `eslint-plugin-boundaries` + TS resolver + lint tsconfig | rejected - native dep + maintained path map + slower lint for no added coverage |
| Hybrid (boundaries for some rules, custom for the rest) | rejected - two overlapping mechanisms, more config surface |
