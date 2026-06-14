# @oss/contracts

## 0.2.0

### Minor Changes

- ADR-0024: restructure the published surface into a small framework foundation + self-contained domain packages.

  - Foundation: `@oss/contracts`, `@oss/runtime`, `@oss/react` (`packages/foundation/`).
  - Domains: `@oss/pam`, `@oss/wallet`, `@oss/casino`, `@oss/sportsbook`, `@oss/cms`, `@oss/engagement` (`packages/domains/`) - each self-contained, no hidden member packages, exposing `/server`, `/contracts`, `/schema`, `/plugins/*`, and (gated) `/migrate`.
  - Renames vs the ADR-0022 facades: `@oss/account` -> `@oss/pam`; `cms` extracted out of `@oss/engagement` into `@oss/cms`. Same-name domains keep byte-stable subpaths.
  - `@oss/platform` is kept as a compat alias for the migration window.
  - Plugin host gains `requiresPorts` for boot-time fail-fast on unbound cross-domain ports (e.g. sportsbook needs `WALLET_COMMANDS` from `@oss/wallet`).

  Fixed-group release, so every `@oss/*` / `@oss-addons/*` package bumps together.

### Patch Changes

- @oss/adapters@0.2.0
- @oss/compliance-invariants@0.2.0
- @oss/orpc-contract@0.2.0
- @oss/shared-schemas@0.2.0
