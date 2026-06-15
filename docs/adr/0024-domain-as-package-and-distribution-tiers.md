# ADR-0024: Domain-as-package + distribution tiers

**Date**: 2026-06-14
**Status**: Accepted + **IMPLEMENTED & PUBLISHED 2026-06-15**, supersedes the packaging decision in ADR-0022. 3 foundation packages (`packages/foundation/{contracts,runtime,react}`), 6 domain packages (`packages/domains/{pam,wallet,casino,sportsbook,cms,engagement}`), `packages/addons/` reduced to the 3 platform-internal/consumer-composed add-ons (admin-console, audit, iam). `@oss/platform` kept as a compat facade. Published at **v0.2.0** to the GitLab registry (the private registry, tag-triggered CI); the consumer migrated (account->pam, cms extracted) and verified (typecheck + build green); the 14 folded `@oss-addons/*` member packages + the `@oss/account` facade deleted from the registry.
**Relates to**: ADR-0021 (everything is a standalone add-on), ADR-0020 (gated add-on editions), ADR-0023 (headless platform), ADR-0002/0014 (plugin + adapter/port seams), ADR-0010/0017 (events + command ports).

## Context

ADR-0022 shipped the published surface as **six domain facades** that re-export ~30 still-published `private:false` member packages. It works and is live (registry the private registry, v0.1.0), but two things aged badly:

1. **Accidental complexity.** "Six packages" actually puts 36 in the registry. The facade is a hollow re-export shell; the real code lives in member packages a consumer can still import. Two-layer mental model (facade vs member) for no consumer benefit.
2. **Grab-bag domains.** `@oss/account` (identity + profile + compliance + player-management) and `@oss/engagement` (chat + notifications + bonus + leaderboard + cms) are bundles of convenience, not units an operator would choose.

The hard requirement that drives the redesign: **an operator must be able to install one domain and nothing else** - a casino owner taking only PAM, or only casino, or PAM + wallet. The facade model allows this in principle, but the member sprawl undercuts it. And we will publish **premium / proprietary add-ons from a private registry** later; the structure must absorb those with zero new architecture.

## Decision

Two **independent** axes. Conflating them is what made ADR-0022 muddy.

### Axis 1 - package shape (how code is structured)

Three shapes, **all identical in surface** (`./server` node, `./react` browser, `./contracts` isomorphic, `./migrate` when it owns tables; `react`/`react-dom`/`@tanstack/react-query` are optional peerDeps so the consumer owns the singletons):

| Shape          | What it is                                 | Depends on                                          |
| -------------- | ------------------------------------------ | --------------------------------------------------- |
| **foundation** | the framework kernel - required by all     | nothing (or each other within foundation)           |
| **domain**     | a self-contained business capability       | foundation only - **never another domain**          |
| **add-on**     | extends one domain through its public seam | foundation + that domain's published `/server` seam |

Foundation (3): `@oss/contracts` (zod root, adapter tokens, contract kit), `@oss/runtime` (createApp, plugin-host, DI Container, db, auth), `@oss/react` (typed client, provider, base hooks).

Domains (6, self-contained packages - **no hidden member packages**): `@oss/pam`, `@oss/wallet`, `@oss/casino`, `@oss/sportsbook`, `@oss/cms`, `@oss/engagement`. Each ships its own service + contracts + react + drizzle migrations behind its subpaths. (Admin is not a domain package - see open items; it stays consumer-composed from each domain's `/server/admin`.)

```
foundation:  @oss/runtime   @oss/contracts   @oss/react
domains:     @oss/pam  @oss/wallet  @oss/casino  @oss/sportsbook  @oss/cms  @oss/engagement  @oss/admin
             (each depends ONLY on foundation; siblings never import each other)
```

This collapses ADR-0022's facade+members into one real package per domain: same a-la-carte benefit, ~half the package count, a public API we can actually keep stable, and a shape third parties can replicate.

### Axis 2 - distribution tier (who can install it)

Tier is an `.npmrc` scope + an entitlement, **not** a code structure. The same package shape ships at any tier:

| Tier                | Registry / location              | Example                                               |
| ------------------- | -------------------------------- | ----------------------------------------------------- |
| **public**          | GitLab `@oss`, npm later         | `@oss/runtime`, `@oss/pam`, `@oss/casino`             |
| **private/premium** | premium registry, licensed token | `@oss/casino-jackpots`, `@oss/pam-aml-pro`            |
| **consumer-local**  | the operator's own repo/scope    | `@my-igaming/jackpot-wheel`, `@my-igaming/fireblocks` |

A premium plugin is just **shape=add-on, tier=private**. The consumer wires all three tiers identically - registry origin is invisible to code:

```ts
import { createApp } from '@oss/runtime';
import { casinoPlugin } from '@oss/casino/server'; // public domain
import { jackpotsPlugin } from '@oss/casino-jackpots/server'; // private premium add-on
import { jackpotWheelPlugin } from '@my-igaming/jackpot-wheel'; // consumer-local Tier-2

createApp({ plugins: [casinoPlugin, jackpotsPlugin, jackpotWheelPlugin] });
```

### The rules that keep this safe long-term

1. **Domains depend ONLY on the foundation, never on each other.** Cross-domain coupling is a **port or event** the operator fills, not an import. Sportsbook declares `WALLET_COMMANDS`; if `@oss/wallet` is not installed the port is unbound and the app fails fast at boot with a named error - it does not silently half-work. (ADR-0017 command ports / ADR-0010 events, unchanged.)
2. **An add-on plugs into an existing published seam** (`casino.gameSeam.defineGame`, an adapter token, an event, a port) - it never patches core. If a premium add-on needs a new extension point, that point ships in the public domain first.
3. **Premium is additive, never required for a valid install.** Strip the `@oss-premium` scope and the free platform still boots. Tier = scope + licensed token; the entitlement check is the only premium-specific code.
4. **Any subset is a valid install.** PAM-only = `@oss/runtime` + `@oss/contracts` + `@oss/pam`. Casino-only, PAM+wallet-only - all valid. This is the requirement the structure exists to serve.

## Migration from ADR-0022 (incremental, consumer-non-breaking)

The facade subpaths (`@oss/<domain>/server|react|contracts|migrate`) are the stable contract. Keep them identical and the fold-in is invisible to the consumer:

1. Stand up the 3 foundation packages (`@oss/contracts`, `@oss/runtime`, `@oss/react`) - mostly a rename/re-home of today's `@oss/platform` kernel split by runtime.
2. Fold each domain's member packages **into** its domain package, one domain at a time, keeping `@oss/<domain>/<subpath>` paths byte-stable. Re-home the grab-bags: split `account` into `@oss/pam` (identity + profile + player-management + compliance/RG) ; split `engagement` cleanly (chat/notifications/bonus/leaderboard stay `@oss/engagement`, `cms` becomes `@oss/cms`); promote `@oss/admin` from the per-domain `/server/admin` routes (admin stays a composing surface, not a god-dependency).
3. Drop the member packages from the registry **last**, once nothing re-exports them.
4. The consumer changes only when a domain name changes (`@oss/account` -> `@oss/pam`); same-name domains need no consumer edit.

## Layout + fold procedure (as implemented)

Target tree: `packages/foundation/{contracts,runtime,react}`, `packages/domains/<name>/`, `packages/addons/<name>/` (only gated/premium add-ons remain). The `packages/*/*` workspace glob already covers the new roots. Boundary gate (`.dependency-cruiser.cjs`): `foundation` joins the core group of `no-core-to-addon`; new `no-core-to-domain` (core may not import `packages/domains/*` except composition roots reading `/schema` + the aggregator reading `/contract`) and `no-cross-domain` (a domain may not import another domain at all - stricter than `no-cross-addon`, which still allows `/schema` reads). The string-level oxlint twin can't yet tell a domain `@oss/<x>` from a foundation `@oss/<x>`; dependency-cruiser is the authoritative domain gate until oxlint gets a domain-specifier list (follow-up).

Per-domain fold steps (proven on wallet, 2026-06-14, full `pnpm verify` green):

1. `git mv packages/addons/<m> packages/domains/<domain>`; delete the old `packages/facades/<domain>` shell.
2. Rename the package `@oss-addons/<m>` -> `@oss/<domain>`, add `private: false`, expand `exports` with the domain subpaths (`/server`, `/contracts`, `/plugins/<m>`) aliasing the existing internal ones (`/plugin`, `/contract`, `/schema`) so importers stay byte-stable.
3. Rewire every `@oss-addons/<m>` importer -> `@oss/<domain>` (source + `package.json` deps, re-sorted): the aggregator (`@oss/orpc-contract`), composition roots (`api-runtime` seed, `testing`), `apps/api` (+ integration tests), and any add-on `/schema` reader.
4. `extensions.config.ts` plugin path -> `./packages/domains/<domain>/dist/plugin.js`. Core domain: central drizzle config schema path -> `../../domains/<domain>/src/schema`. Gated domain: keep its own `drizzle.config.ts` + migrations.
5. `pnpm install && pnpm verify`. The RLS-coverage test already scans `packages/domains` alongside `packages/addons`.

## Consequences

- **~10 meaningful packages** instead of 36; each is a thing an operator chooses.
- **One stable public API per domain** - internal refactors inside a domain stay non-breaking; the member-vs-facade split disappears.
- **Premium + third-party ecosystem with zero new architecture** - add-on-shape on a private scope. `@acme/igaming-poker` and `@oss/casino-jackpots` are the same shape as a free domain.
- **One restructure cost** - member code gets absorbed into domains; needs a real port-binding check (fail-fast on unbound `WALLET_COMMANDS` etc.).
- **ADR-0021 source isolation is preserved within each domain** (schema/contract/service/router/plugin layering, boundary lint) - the change is the _distribution_ unit, not the internal module model.
- **ADR-0020 editions** still apply: a domain can be gated; the free core boots without it.

## Open items

- Exact home for `compliance/RG` (inside `@oss/pam` vs its own `@oss/compliance`) - leaning PAM since RG limits are player-scoped.
- ~~Whether `@oss/admin` is a published domain or stays a consumer-composed Tier-2 surface.~~ **Resolved 2026-06-14:** stays consumer-composed. Each domain owns its `/server/admin` routes; the back office composes them gated by platform RBAC. No standalone `@oss/admin` domain package - a package depending on every domain inverts the one rule (domains depend only on the foundation) and creates an ever-growing roof. So `@oss/admin` is dropped from the target domain list; the target is **6 domains** (`@oss/pam`, `@oss/wallet`, `@oss/casino`, `@oss/sportsbook`, `@oss/cms`, `@oss/engagement`) + 3 foundation. Revisit only if a published cross-domain admin surface becomes a hard consumer requirement.
- ~~Foundation naming: `@oss/runtime` vs keeping `@oss/platform`.~~ **Resolved 2026-06-14:** foundation is `@oss/runtime` (node kernel) + `@oss/contracts` (isomorphic) + `@oss/react` (browser, already exists). Stood up additively; `@oss/platform` is kept as a compat alias for the migration window and removed with the member packages (task #14), so apps/api and the consumer keep building unchanged until they migrate their imports.
