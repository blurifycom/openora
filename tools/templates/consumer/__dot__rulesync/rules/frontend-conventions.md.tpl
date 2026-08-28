---
root: false
targets:
  - '*'
globs:
  - 'apps/web/**'
  - 'apps/backoffice/**'
  - 'packages/ui/**'
description: React/UI conventions (component library, theming, i18n, permission gating, modular architecture) for apps/web, apps/backoffice, packages/ui - the always-on core; full detail in docs/standards/frontend.md.
---

# Frontend conventions

UI-specific rules for `apps/web`, `apps/backoffice`, and `packages/ui`. Stack-agnostic rules (naming, types, functions, comments, errors, testing, git) live in `conventions`. Styling, i18n, and the modular architecture are specified in `docs/standards/frontend.md` - read it before touching a component, page, or module. The rules below are the ones that file does not state.

## Component library

- `{{scope}}/ui` is the component library: compose from its primitives (`Button`, `Dialog`, `Select`, `Switch`, `Tabs`, `Badge`, ...) plus utility classes on the theme tokens. Don't hand-roll what a primitive already provides; a genuinely missing one is added to `packages/ui/src/primitives/`.
- Theme tokens and CSS variables are declared once in `packages/ui/themes.css`; `cn()` and `registerTranslations()` come from the `{{scope}}/ui` barrel - never deep-import.
- `{{scope}}/ui` is consumed pre-built, so the React Compiler exception in `docs/standards/frontend.md` applies to it.

## Permission-gated UI

A page, nav item, tab, panel, or write action gated on a permission must check the exact resource/level the backend route actually asserts (`adminGuard.assert(resource, action)`) - never a looser, unrelated, or merely-plausible resource, and never a coarse "is admin" shortcut. Confirm the check against the route/service being called, not against what reads correctly at a glance.

- Gate at every layer the feature touches, and keep them in agreement: the nav entry, the route guard, the data-fetching hook's `enabled`, and the rendered branch. A mismatch between any two of these reopens the exact bug class this guards against - a request that fires (and 403s) before the UI hides itself, a control shown that fails on click, or a section rendering an empty/failed state instead of disappearing.
- Thread the permission into the query hook itself (`enabled: Boolean(id) && useHasPermission(resource, level)`), not only into the component that renders it - a hook with no grant check still fires for any caller that forgets the wrapper, including ones added later.
- A missing or denied permission hides the section outright - never a failed-to-load screen, an empty state standing in for "no access," or a disabled-but-visible control. See `conventions` > Testing: cover the authz-negative for every new gate as part of the same change.

## Modular architecture

- Outer composition code (`src/app/`, `src/routes/`) imports a module only as `@/modules/<name>`; files inside a module use relative paths to siblings.
- Cross-module communication is query invalidation, never a direct import.
