# ADR-0025: Single `@openora/core` package, modules as subpaths

**Date**: 2026-06-16
**Status**: Accepted + **IMPLEMENTED 2026-06-16**, supersedes the packaging decision in ADR-0024 (and the chain ADR-0022 -> ADR-0024). Keeps ADR-0024's two-axes framing and source-isolation rules; changes ONLY the published-package count: from ~10 packages (3 foundation + 6 domains + gated add-ons) to **one** public package `@openora/core` whose modules are subpaths.

**Implementation note (2026-06-16):** Done in verified stages. `platform/core` (the DI kernel) was renamed `@openora/kernel` to free the `@openora/core` name. The 8 foundation/engine packages (`@openora/{shared-schemas,adapters,orpc-contract,kernel,db,auth,plugin-host,api-runtime}`) folded into `packages/core/src/{contracts,server}` with `react` + `compliance` alongside; the standalone packages were deleted and ~106 importers rewritten to `@openora/core/{contracts,server}`. `createApp` was made domain-agnostic (DI: the consumer injects the PAM identity schema + a `resolveTenant`); demo seeding moved to `@openora/testing`. The central drizzle migration history lives at `packages/core/drizzle`. Boundary lint re-pointed: `no-core-to-{domain,addon}` guard `packages/core`; `no-{react,contracts}-to-runtime` guard the `core/src/{react,contracts}` zones against `core/src/server`. The `KycStatus` name collision the merge exposed was resolved by renaming the KYC-vendor enum to `KycVendorStatus`. Remaining: `@openora/mcp` + `@openora/testing` stay separate dev/tooling packages (not folded); domain modules are not yet re-split (PAM still bundles identity/profile/compliance) - see open items.
**Relates to**: ADR-0024 (domain-as-package - packaging superseded, rules kept), ADR-0021 (everything is a standalone add-on), ADR-0020 (gated add-on editions), ADR-0015 (boundary lint), ADR-0017 (extraction-readiness ports/manifest).

## Context

ADR-0024 published the platform as ~10 packages: foundation (`@openora/contracts`, `@openora/runtime`, `@openora/react`), 6 domains (`@openora/pam`, `@openora/wallet`, ...), and gated add-ons. It is correct and live. But once every domain is **source-isolated** (zero cross-domain imports, lint-enforced), the split foundation packages stop earning their keep:

- `@openora/contracts` and `@openora/react` became **aggregators of nothing** - each module already owns its contract slice and its react hooks. A shared "contracts" / "react" package only re-collects what modules export. (This is what the in-flight refactor already proved: `@openora/orpc-contract` was reduced to a pure `composeContract` + `healthContract`, and `@openora/react` to a domain-free generic client.)
- 10 published packages + their cross-version compatibility matrix is real operator-facing complexity for a platform whose code is **fully public** anyway. There is nothing to withhold at the package boundary - so the package boundary buys only independent versioning, which we do not need yet.

The operator-facing requirements have NOT changed and must still hold:

1. **Use one module only** - a casino owner enabling only the player (PAM) module, or only wallet, or all (by configuration).
2. **Premium / proprietary modules** live in a separate repo, publish to a private registry (`@openora/extra-feature`), and the consumer wires them into its composition root exactly like a free module.
3. **A module can be extracted later** to its own repo/registry "because it is isolated" - without an expensive untangle.

The trap (days of circling): these read like they fight a single-package model. They do not - they live on three independent axes.

## Decision

Publish **one** public package, `@openora/core`. Every engine piece, shared primitive, and free business module is a **subpath** of it. Premium modules stay separate packages. Config stays a dev-only package.

```
@openora/core
  /contracts   composeContract, healthContract, sealed-token primitives, base schemas (money/id/pagination)
  /react       generic client / provider / query glue - domain-free
  /server      engine: api-runtime (createApp) + plugin-host (DI, sealed-token runtime reject) + db + auth
  /compliance  sealed-token list + invariants
  /player  /wallet  /casino  /engagement  /cms   <- free business modules
     each: /contracts /schemas /db /server /react /admin
```

Premium (separate repo, private registry, **add-on shape**, deps `@openora/core`): `@openora/extra-feature`, today's gated set (sportsbook, iam, audit, admin-console, leaderboard, aggregator) as they move out.

Dev-only: `@openora/config` (tsconfig / oxlint / turbo-generators / vitest base).

Not published: `apps/*` (the composition root that assembles core + enabled modules).

### The three axes (why one package serves all three requirements)

| Operator wants                                        | Axis                 | Mechanism with one `@openora/core`                                                                                                                                                                                                                                                           |
| ----------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| use only player, or only wallet                       | **runtime**          | install whole `@openora/core`; config (`OSS_ADDONS` / `applyEdition`, extended to core modules) enables only that module's plugin -> only its routes served. Frontend tree-shakes unused subpaths out of the bundle. Disk holds all code; the running surface and the shipped bundle do not. |
| premium on private registry, wired like a free module | **package boundary** | premium = add-on shape, private scope. Separate package, deps `@openora/core`. Consumer imports it identically to a core subpath. (= ADR-0024 axis 2, unchanged.)                                                                                                                            |
| extract a module to its own repo later                | **source move**      | modules are source-isolated, so extraction is a mechanical folder move - no code untangle. See escape hatch below.                                                                                                                                                                           |

These are orthogonal. A single published package constrains none of them.

### Extraction escape hatch (the requirement that felt blocked)

Source isolation (ADR-0021/0024, enforced by `no-cross-domain`) makes extraction **mechanical**: a module imports only `@openora/core/{contracts,react,server}` primitives and its own files, never a sibling, so the folder lifts out cleanly. The ONE thing that would otherwise break is the consumer import path (`@openora/core/wallet` -> `@openora/wallet`). Neutralize it with a re-export shim:

```ts
// @openora/core/wallet, after @openora/wallet is extracted to its own package
export * from '@openora/wallet';
```

`@openora/core` then depends on the extracted `@openora/wallet`; consumer imports of `@openora/core/wallet` stay byte-stable -> **non-breaking extraction**. Drop the shim in a later major if desired. So "one package now" forecloses no future split.

### Rules that keep this safe (inherited, non-negotiable)

1. **Modules depend only on core primitives, never on a sibling module.** Cross-module needs go through a port or event the operator fills (ADR-0017 command ports / ADR-0010 events), not an import. Enforced by `no-cross-domain` / `no-cross-addon` (ADR-0015).
2. **`/react` and `/contracts` subpaths MUST NOT import `/server` or `/db`.** Otherwise a frontend bundle pulls Drizzle/Hono. New boundary rules `no-react-to-server` / `no-contracts-to-server` enforce it; this is the single new guardrail one-package introduces.
3. **Subpath names are the stable public contract.** Renaming a module subpath is a breaking change; treat subpath names like package names.
4. **Premium is additive.** Strip the private scope and the free `@openora/core` still boots. Tier = scope + licensed token (ADR-0024 axis 2, ADR-0020 editions).

## Consequences

- **One public package** instead of ~10; one install, one version, no cross-package compatibility matrix for the free platform.
- **`@openora/contracts` and `@openora/react` disappear as packages** - they become `@openora/core/contracts` and `@openora/core/react`. Module-specific schemas/hooks move INTO their module; only genuinely cross-cutting primitives (composeContract, base money/id schemas, generic client glue) live in the shared subpaths.
- **No independent module versioning** - bump anything, bump `@openora/core`. Accepted: extraction (above) is the pressure valve if a module ever needs its own cadence.
- **One new failure mode** - a `/react` or `/contracts` subpath accidentally importing server/db code leaks heavy deps into the client bundle. Mitigated by the new boundary rules (rule 2).
- **Source-isolation model is unchanged** - this ADR moves only the _distribution unit_. ADR-0021 internal layering, ADR-0020 editions, ADR-0017 ports/manifest all stand.
- **Premium / third-party ecosystem unchanged** - still add-on-shape on a private scope, deps `@openora/core`.

## Open items

- Module granularity: today `packages/domains/pam` bundles identity + profile + compliance + player-management. The target sketch wants `core/player` and `core/compliance` as separate subpaths. Decide whether to re-split PAM during the fold or keep it whole and split later (subpath rename = breaking, so prefer settling names before first publish).
- Exact home of the engine: single `@openora/core/server` subpath vs finer (`/server`, `/db`, `/auth`). Leaning one `/server` barrel that re-exports, to keep the consumer's mental model small.
- `@openora/mcp` and `@openora/testing` (current `platform/*`): fold into `@openora/core` (dev/test subpath) or keep as separate dev-only packages alongside `@openora/config`. Leaning dev-only separate, since they are not part of the runtime surface.
