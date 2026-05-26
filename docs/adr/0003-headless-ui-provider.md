# ADR-0003: Headless UI via provider contract + adapter packages

**Date**: 2026-05-18
**Status**: Accepted

## Context

iGaming operators have strong branding requirements. Some run multiple brands. Others want to use their existing design system. Baking shadcn/ui (or any library) into module UI pages would make the platform hard to restyle without forking.

We also want the MCP server and AI agents to understand the component surface without parsing JSX trees.

## Decision

Define a **UI provider contract** in `@oss/ui-provider-contract`: TypeScript interfaces for each component (Button, Form, Table, Dialog, etc.) and a union of named slot strings (`header-right`, `sidebar-bottom`, `user-menu`, ...).

Module UI pages (`packages/modules/<name>/ui/`) import only from `@oss/ui-provider-contract`. The default implementation `@oss/ui-provider-shadcn` ships with the repo. Any adapter that satisfies the contract can be swapped in.

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
