# ADR-0003: Headless UI via provider contract + adapter packages

**Date**: 2026-05-18
**Status**: Superseded (2026-06-10)

> **Superseded (2026-06-10):** The UI provider contract (`@oss/ui-provider-contract`) and the shipped daisyUI adapter (`@oss/ui-provider-daisyui`) were removed. The platform is now headless backend only - all UI lives in the downstream consumer (consumer). Modules no longer declare UI components, and no UI packages ship from this repo. Frontend development is entirely out-of-tree. This ADR is preserved as historical record of the exploration.

## Context

iGaming operators have strong branding requirements. Some run multiple brands. Others want to use their existing design system. Baking shadcn/ui (or any library) into module UI pages would make the platform hard to restyle without forking.

We also want the MCP server and AI agents to understand the component surface without parsing JSX trees.

## Decision

Define a **UI provider contract** in `@oss/ui-provider-contract`: TypeScript interfaces for each component (Button, Form, Table, Dialog, etc.) and a union of named slot strings (`header-right`, `sidebar-bottom`, `user-menu`, ...).

Module UI pages (`packages/modules/<name>/ui/`) import only from `@oss/ui-provider-contract`. The shipped implementation `@oss/ui-provider-daisyui` (Tailwind v4 + DaisyUI) ships with the repo. Any adapter that satisfies the contract can be swapped in.

At runtime, the backoffice app imports one concrete provider and passes it to the root context.

Inspired by: Refine's provider pattern, Strapi v5's injection zones.

## Consequences

**Positive:**

- Swapping the entire UI library = change one import in the backoffice app.
- AI agents can describe components using the contract types, not implementation details.
- Community can publish `@<org>/ui-provider-<lib>` packages.
- Storybook documents the contract, not a specific library.

**Negative / trade-offs:**

- Writing every UI component twice (contract + impl). Mitigated by the `/scaffold-ui-component` command.
- Contract evolution needs care: adding a prop is backward-compatible; removing/renaming is breaking.

**Neutral:**

- Named slots are strings, not typed component overrides. This keeps them easy to enumerate for the MCP server.
- Most operators ship their own player UI, so the adapter indirection is strictly speaking optional for them. We keep it in core anyway because it earns its place three ways: (1) a working reference UI (the shipped `daisyui` adapter) keeps the repo fully playable out of the box; (2) the contract lets every `@oss/react-sdk` page stay UI-library-agnostic, so a consumer restyles by swapping one provider instead of forking pages; (3) it is the on-ramp - a consumer can ship on the shipped adapter, then move to its own adapter when ready. The cost is low: the contract is small and additive-only.

## Update (2026-05-28): single shipped adapter

The original `@oss/ui-provider-shadcn` reference adapter (headless HTML + `data-*` skinned by `react-sdk/styles.css`) was removed. **DaisyUI (`@oss/ui-provider-daisyui`) is now the single adapter shipped by the platform** - one UI provider everywhere (apps, Storybook, scaffolder templates, examples). The provider contract is retained exactly as decided above, so consumers can still implement and swap in their own adapter without touching modules or pages. DaisyUI requires Tailwind v4 + the daisyUI plugin wired into each app's CSS build (`@import "tailwindcss"; @plugin "daisyui";` via `@tailwindcss/postcss` for Next or `@tailwindcss/vite` for Vite); the OSS apps and the `pnpm create:app` templates ship that wiring.
