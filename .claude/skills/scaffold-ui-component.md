---
name: scaffold-ui-component
description: Create a paired UI contract + daisyui implementation + Storybook story. Arg: <ComponentName> (PascalCase).
---

Run `pnpm scaffold ui-component $ARGUMENTS` in the repo root.

After scaffolding:

1. Define the props type in `packages/ui/provider-contract/src/index.ts` and add the component to the `UIProvider` type.
2. Implement in `packages/ui/provider-daisyui/src/<name>.tsx` using DaisyUI semantic classes (`btn`, `card`, `modal`, ...). The react-sdk `styles.css` supplies structural/layout classes (driven by `--bo-*` theme variables); DaisyUI supplies the component look.
3. Write a **contract-driven** Storybook story in `apps/storybook/stories/<name>.stories.tsx`. Do NOT import the component from `@oss/ui-provider-daisyui`. Pull it from the storybook-local `useUI()` in `apps/storybook/.storybook/adapters.tsx`, so the same story renders through every registered adapter via the toolbar switcher:
   ```tsx
   import { useUI } from '../.storybook/adapters';
   function Demo(args) { const { <Name> } = useUI(); return <<Name> {...args} />; }
   ```
4. Export the component from `provider-daisyui/src/index.ts` - it's part of the `daisyuiProvider` object, typed `: UIProvider`, so TS enforces the contract.
5. Run `pnpm verify`.

Remind the user: module/admin UI consumes components via `useUI()` (from `@oss/react-sdk`), never `@oss/ui-provider-daisyui` directly. provider-contract is the binding interface; daisyui is the single shipped adapter.
