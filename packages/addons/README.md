# Add-ons

Gated `@openora-addons/<name>` packages live here, one directory each. None ship today.

This directory must exist even while it is empty: the module scaffolder treats
`packages/addons/` as the marker for "am I inside the OSS monorepo?"
(`isOssRepo()` in `packages/core/turbo-generators/src/config.ts`). Without it,
`pnpm gen module|route|config|event|service|app` fail with an "only runs inside
the oss monorepo" error on a fresh clone.

Create one with `pnpm gen module <name>`; it registers itself in `extensions.config.ts`.
