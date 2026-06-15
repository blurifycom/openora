# Changesets

This folder drives versioning + publishing of the `@oss/*` and `@oss-addons/*` packages
to the GitLab package registry. The whole set shares **one fixed version** (see
`config.json` `fixed`), so a downstream consumer pins a single range. See
[ADR-0022](../docs/adr/0022-domain-distribution-packages.md).

- Add a changeset for a publishable change: `pnpm changeset` (pick bump, write summary).
- Version locally: `pnpm version` (`changeset version`) — bumps the fixed group in lockstep.
- Publish: CI runs `pnpm release` (`changeset publish`) on a `v*` tag.

Private packages (`@oss/api`, `@oss/mcp`, config/testing) are never published — `private: true`
excludes them automatically.
