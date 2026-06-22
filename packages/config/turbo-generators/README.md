# @blurifycom/turbo-generators

Shared `turbo gen` generators for downstream igaming consumers. The generator logic and
templates live here once, so each consumer repo's `turbo/generators/config.ts` is a
one-line re-export instead of a maintained copy:

```ts
export { default } from '@blurifycom/turbo-generators';
```

`pnpm gen <name>` then works in the consumer with no drift against the platform.

## Generators

| Name      | Emits                                                                  |
| --------- | ---------------------------------------------------------------------- |
| `plugin`  | overlay plugin under `apps/api/src/extensions/<name>/plugin.ts`        |
| `adapter` | overlay that rebinds a vendor adapter DI token (payment / KYC / notif) |

## How it resolves

`turbo gen` bundles the re-exported config into a CJS file inside the consumer repo, so
`import.meta.url` is unavailable and the `.hbs` files in `src/templates/` are not copied.
`config.ts` resolves this package's own install dir via `require.resolve` (through the
consumer's `node_modules` symlink) and reads templates by absolute path - so editing a
`.hbs` here updates every consumer with no copy step.
