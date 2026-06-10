---
targets:
  - '*'
description: 'Create a paired UI contract + daisyui implementation. Arg: <ComponentName> (PascalCase).'
---

Run `pnpm gen ui-component $ARGUMENTS` in the repo root (`pnpm scaffold ui-component ...` still
works as an alias).

After scaffolding:

1. Define the props type in `packages/ui/provider-contract/src/index.ts` and add the
   component to the `UIProvider` type. Module + page code consumes the component via
   `useUI()` against this contract.
2. Implement in `packages/ui/provider-daisyui/src/<name>.tsx` using DaisyUI semantic
   classes (`btn`, `card`, `modal`, ...). DaisyUI supplies the component look; the
   consumer frontend owns layout / `--bo-*` design tokens (this repo is headless).
3. Export the component from `provider-daisyui/src/index.ts` - it's part of the
   `daisyuiProvider` object, typed `: UIProvider`, so TS enforces the contract.
4. Run `pnpm verify`.

Remind the user: UI consumes components via `useUI()` from `@oss/react-hooks`, never
`@oss/ui-provider-daisyui` directly. provider-contract is the binding interface; daisyui is
the single shipped adapter.
