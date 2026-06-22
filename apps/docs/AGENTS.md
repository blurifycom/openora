# apps/docs - documentation site

A [Fumadocs](https://fumadocs.dev) (Next.js) site that publishes the platform's docs as a
browsable website with search, an API reference, and rendered Mermaid diagrams.

## This is tooling, not product UI

The platform is headless - it ships no product UI (that lives in the downstream consumer).
This app is **project tooling** (same category as `apps/mcp-server-dev`): it is `private`,
never published to npm, and ships no platform components. It does not violate the headless
principle.

## Single source of truth is `/docs`

All prose content is **generated** from the repo-root `docs/` Markdown by
`tools/gen-docs-content.ts` (the same pattern as `docs/catalog.json`). Do NOT edit
`apps/docs/content/` - it is gitignored and rebuilt on every `dev`/`build`. Edit the
Markdown under `/docs` instead, then re-run the generator.

The generator:

- transforms every `docs/**/*.md` into `content/docs/**/*.mdx` (injects `title`/`description`
  frontmatter from the leading `# H1`, builds `meta.json` nav ordering),
- copies `docs/openapi.json` to `apps/docs/openapi.json` and generates the API reference MDX
  via `fumadocs-openapi`,
- **scrubs vendor/brand names** and fails loudly if any survive - the published OSS site must
  stay vendor-neutral.

`docs/openapi.json` is emitted by `pnpm --filter @oss/api codegen`; run it before building so
the API reference is current.

## Commands

```
pnpm --filter @oss/docs docs:gen   # regenerate content from /docs (+ openapi)
pnpm --filter @oss/docs dev        # local dev server (runs docs:gen first)
pnpm --filter @oss/docs build      # static export to apps/docs/out
pnpm --filter @oss/docs typecheck  # fumadocs-mdx + next typegen + tsc
```

## Mermaid

Existing ` ```mermaid ` fenced blocks in `/docs` render natively via the `remarkMdxMermaid`
plugin (configured in `source.config.ts`) + the `Mermaid` component. No per-file changes.

## Deployment (deferred)

`next.config.mjs` sets `output: 'export'`, so `build` emits a static site to `apps/docs/out`
deployable to any static host. A GitHub Pages workflow is intentionally NOT wired yet; when it
lands it should run `pnpm --filter @oss/api codegen` then `pnpm --filter @oss/docs build`, set
`DOCS_BASE_PATH` to the project sub-path, and publish `apps/docs/out`.
