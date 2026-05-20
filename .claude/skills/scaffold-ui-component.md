---
name: scaffold-ui-component
description: Create a paired UI contract + shadcn implementation + Storybook story. Arg: <ComponentName> (PascalCase).
---

Run `pnpm scaffold ui-component $ARGUMENTS` in the repo root.

After scaffolding:

1. Define the props type in `packages/ui/provider-contract/src/index.ts` and add the component to the `UIProvider` type.
2. Implement in `packages/ui/provider-shadcn/src/<name>.tsx`. Keep it structural with `data-*` attributes where possible - the visual skin lives in `packages/sdks/react-sdk/src/styles.css` (driven by `--bo-*` theme variables), so one CSS file restyles every consumer.
3. Write a **contract-driven** Storybook story in `apps/storybook/stories/<name>.stories.tsx`. Do NOT import the component from `@oss/ui-provider-shadcn`. Pull it from the storybook-local `useUI()` in `apps/storybook/.storybook/adapters.tsx`, so the same story renders through every registered adapter via the toolbar switcher:
   ```tsx
   import { useUI } from '../.storybook/adapters';
   function Demo(args) { const { <Name> } = useUI(); return <<Name> {...args} />; }
   ```
4. Export the component from `provider-shadcn/src/index.ts` - it's part of the `shadcnProvider` object, typed `: UIProvider`, so TS enforces the contract.
5. Run `pnpm verify`.

Remind the user: module/admin UI consumes components via `useUI()` (from `@oss/react-sdk`), never `@oss/ui-provider-shadcn` directly. provider-contract is the binding interface; shadcn is the default adapter.
