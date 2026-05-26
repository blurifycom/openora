# minimal-igaming

The canonical "start here" downstream-consumer example. It is the smallest thing
that boots a real igaming API on top of the `@oss/*` packages without forking core.

This mirrors the working `../consumer` consumer (same `pnpm.overrides` + `link:`
wiring, same `createApp` entrypoint, same built-dist plugin paths) - just trimmed
to a handful of modules so the pattern is obvious. For the full reference see
[`docs/downstream-consumer.md`](../../docs/downstream-consumer.md) and the
machine-readable surface in [`docs/CATALOG.md`](../../docs/CATALOG.md).

> Reference only. `examples/*` is NOT a pnpm workspace member, so `pnpm verify`
> does not build this folder. Copy it out to a sibling repo to run it.

## What this shows

- `src/main.ts` - boot the API with `createApp({ plugins, igaming, port, cors, openapi })`.
- `src/extensions.config.ts` - the consumer's own plugin list, pointing at the
  built `@oss/modules` dist plus one local overlay.
- `src/extensions/stripe-payment/plugin.ts` - an overlay that binds a custom
  `PaymentAdapter` to `PAYMENT_ADAPTER`, loaded AFTER `wallet` so it wins
  (last registration of a token wins).
- `src/providers.tsx` - the UI side: wrap a Next app with the `@oss/react-sdk`
  providers + the shadcn UI adapter.
- `package.json` - the `pnpm.overrides` + `link:` block that points every `@oss/*`
  package at this repo's source.

## Prerequisites

- Node >= 22, pnpm >= 10
- A Postgres + Redis reachable via `DATABASE_URL` (see the OSS repo's docker setup)
- This `igaming-oss` repo checked out as a sibling of your consumer repo, eg:
  ```
  parent/
    igaming-oss/        <- this repo
    my-igaming/         <- a copy of examples/minimal-igaming
  ```

## Run steps

1. Copy this folder out next to `igaming-oss` and install. The `link:` paths in
   `package.json` resolve relative to the consumer dir, so a sibling layout is
   assumed (`../igaming-oss/...`).
   ```bash
   cp -r igaming-oss/examples/minimal-igaming my-igaming
   cd my-igaming
   pnpm install
   ```

2. Build the OSS packages this consumer links against, then build `@oss/modules`
   (the plugin dist the registry points at MUST exist before boot):
   ```bash
   pnpm build:oss
   ```

3. Boot the API:
   ```bash
   DATABASE_URL=postgres://... pnpm dev
   ```
   It listens on `:3001`, emits `docs/openapi.json`, and loads the modules listed
   in `src/extensions.config.ts` (plus the Stripe overlay).

## Keeping the link hot during dev

Run a watch build in the OSS repo in parallel with this consumer's `pnpm dev`:

```bash
# in ../igaming-oss
pnpm -r --filter '@oss/*' --parallel build --watch
```

Module plugin dist (`@oss/modules`) must be rebuilt when you touch module source -
`pnpm -F @oss/modules build` (or include it in the watch loop).
