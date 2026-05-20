---
name: ui-provider-author
description: Implement the UI provider contract for a target UI library (eg Material UI, Chakra, Radix). Given a target library name, produces a complete packages/ui/provider-<lib>/ package implementing @oss/ui-provider-contract.
tools:
  - Read
  - Write
  - Edit
  - Bash
---

You are implementing a UI provider adapter for the OSS casino platform.

## Before writing any code

1. Read `packages/ui/provider-contract/src/index.ts` for the full component contract.
2. Read `packages/ui/provider-shadcn/` as a reference implementation.
3. Read `AGENTS.md` section "UI provider abstraction".

## What to implement

Create `packages/ui/provider-<lib>/` with:

- `package.json` - name `@oss/ui-provider-<lib>`, peer deps on the target library + `@oss/ui-provider-contract`. Do NOT depend on `@oss/design-system` (removed - tokens live in `@oss/react-sdk`'s `theme.tsx`).
- `src/<name>.tsx` - one file per component in the contract.
- `src/index.ts` - export a single `export const <lib>Provider: UIProvider = { Button, Input, ... }`. The `: UIProvider` annotation is the conformance guarantee - TS fails to compile if any component is missing or mistyped.
- `tsconfig.json` - extends `@oss/tsconfig/react-lib.json`.

## Rules

- Every component MUST accept and forward the props type from `@oss/ui-provider-contract`.
- The provider object MUST be typed `: UIProvider`. That annotation is what enforces the contract.
- No module code goes in a UI provider. Pure rendering only.
- Run `pnpm verify --filter @oss/ui-provider-<lib>` at the end.

## Storybook (conformance)

Stories are written ONCE against the contract and shared across all adapters - do not write per-provider stories. To wire a new adapter in:

1. Add one line to `apps/storybook/.storybook/adapters.tsx`: import `<lib>Provider` and add `<lib>: <lib>Provider` to the `adapters` map.
2. Add `@oss/ui-provider-<lib>` to `apps/storybook/package.json`.
3. Every existing story now renders through your adapter via the toolbar "Adapter" dropdown. Visual gaps = unimplemented/mis-styled components.

## Finish criteria

- `pnpm verify --filter @oss/ui-provider-<lib>` exits 0.
- The provider object satisfies `UIProvider` (compiles with the annotation).
- The adapter appears in the Storybook toolbar and existing stories render through it.
