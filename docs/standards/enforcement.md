# Enforcement

Detail for the enforcement line in `conventions`. Read this when a gate fails or when adding a lint rule.

- `pnpm verify` = typecheck + lint + format + boundaries + module-shape + deprecations + `test:unit` + `test:integration` + `test:tools`. CI adds `pnpm check:drift`.
- Two-layer boundaries - per-edit oxlint (`oss-boundaries/*`) plus the whole-graph dependency-cruiser (`pnpm check:boundaries`, catches transitive edges, barrel laundering, dynamic `import()`). Don't work around a violation; fix the import.
- Module structure + naming are lint-enforced (`oss-module-shape/*` oxlint JS plugin, `tools/lint/oxlint-module-shape-plugin.mjs`): files sit in a canonical layer dir, `service/` files end `.service.ts`, `__tests__/` files end `.test.ts`, an infra-backed test ends `.int.test.ts`, filenames kebab-case, no inline `pgEnum` value arrays.
- oxlint config is split: the published `@openora/core/oxlint/oxlintrc.json` holds the universal, stack-agnostic rules (base rules, `typescript/no-explicit-any`, `typescript/no-non-null-assertion`, `typescript/consistent-type-definitions`, `import/no-cycle`, `import/no-duplicates`) - the single source of truth a consumer extends via `"extends": ["./node_modules/@openora/core/oxlint/oxlintrc.json"]`. The root `.oxlintrc.json` here `extends` that shared config and adds only OSS-internal rules (`oss-boundaries/*`, `oss-module-shape/*`, `unicorn/filename-case`) that need the local `jsPlugins`.
- Generated migrations are byte-sensitive: drizzle hashes each file to decide what is already applied, so formatting hooks skip `**/drizzle/migrations/*.sql` and nothing may hand-edit them.
- Pre-commit runs `pnpm check:boundaries` + `pnpm check:types`; CI runs `pnpm verify`, which ends with the no-drift check.
- `pnpm verify` runs `build` rather than `check:types`: every package builds with `tsc` over the tsconfig its `check:types` uses, so the build IS the typecheck and running both compiles the workspace twice. `pnpm check:types` stays for ad-hoc and pre-commit use.
- Agent rules mirror this standard - generated from `.rulesync/` via `pnpm gen:agents`.
