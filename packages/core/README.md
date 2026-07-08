# @openora/core

> Open-source, headless, plugin-based, AI-native iGaming framework. Clone it, extend it, deploy it - without forking core.

The single package behind [Openora](https://github.com/blurifycom/openora): backend domain modules (auth, wallet, casino, sportsbook, bonus, compliance, CMS, backoffice, audit), the plugin engine that composes them, Zod-first contracts, and a typed React SDK. Your frontend, branding, and vendor adapters live in your own consumer repo and talk to it over HTTP.

> **Status: alpha (pre-1.0).** Contracts, package layout, and APIs may change between releases.

## Install

```sh
pnpm add @openora/core        # latest stable
pnpm add @openora/core@alpha  # dev channel snapshot
```

## What's inside (subpath exports)

| Subpath                          | Surface                                                                                        |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@openora/core/contracts`        | Isomorphic Zod schemas, contract composition, adapter ports + DI tokens                        |
| `@openora/core/server`           | The engine: `createApp`, plugin host (`definePlugin`), DI container, EventBus, Drizzle service |
| `@openora/core/react`            | Typed client, auth, realtime hooks for your frontend (no UI components)                        |
| `@openora/core/<domain>`         | A domain's public contract surface, eg `wallet`, `compliance`, `engagement`                    |
| `@openora/core/<domain>/schema`  | Read-only Drizzle tables for cross-module reads                                                |
| `@openora/core/<domain>/plugins` | The domain's plugin entry for your composition root                                            |

Everything enters through plugins - `definePlugin({ id, dependsOn, register })` - wired explicitly in your app's `extensions.config.ts`. No decorators, no auto-discovery.

## Principles

- **Headless** - no UI ships here; the SDK is hooks + a typed client.
- **Zod-first** - every wire shape is a schema; types are inferred, never hand-written.
- **Swappable vendor seams** - PSP, KYC, game aggregator, realtime, job queue, and message broker are ports with in-process defaults and adapter overrides.
- **Regulatory-grade audit** - append-only, sha256 hash-chained log; every state-changing action leaves a trail.
- **AI-native** - machine-readable catalog, per-module agent docs, and a queryable MCP server ([`@openora/mcp`](https://www.npmjs.com/package/@openora/mcp)).

## Getting started

The fastest path is the consumer scaffold and docs in the [main repository](https://github.com/blurifycom/openora) - it walks through booting an API, enabling modules, and overriding adapters.

## License

[AGPL-3.0-only](./LICENSE). A commercial license is available - see [LICENSE-COMMERCIAL.md](./LICENSE-COMMERCIAL.md).
