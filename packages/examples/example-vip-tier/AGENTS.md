# @oss/example-vip-tier

Reference UI plugin demonstrating every v1 extension surface (ADR-0013).

## What it demonstrates

| Surface | Tier | Mechanism |
|---|---|---|
| VIP column on players list | T1 | `columns` + `requiresPermission` + `featureFlag` + `brandScope` |
| VIP section on player detail | T1 | `slots.fill(playerDetail.sections)` + `usePageContext` (in real use) |
| Lobby ribbon | T1 | `slots.fill(playerLobby.ribbon)` + `featureFlag` |
| Game-tile decorator | T1 | `slots.fill(playerGameTile.decorator)` |
| One shared fetch across surfaces | cross-cut | `useDataExtension('vip-tier', 'rows', ...)` (sample wiring) |
| Plugin self-validation | test kit | `assertValidPlugin()` at module load |
| Sealed-token typecheck demo | compliance | see `src/sealed-fail-demo.ts.skip` |

## How a consumer wires it

```ts
// consumer/apps/backoffice/src/providers.tsx
import vipTier from '@oss/example-vip-tier';
import { UIPluginProvider, SlotEvaluationContextProvider } from '@oss/react-pages';

<UIPluginProvider plugins={[vipTier]}>
  <SlotEvaluationContextProvider
    permissions={session.permissions}
    brand={config.activeBrand ?? null}
    features={config.features}
  >
    {/* admin shell */}
  </SlotEvaluationContextProvider>
</UIPluginProvider>
```

Flip the `vipTier` feature flag in `platform-config.yaml` to enable / disable
the column + sections without redeploying:

```yaml
features:
  vipTier: true
activeBrand: casino-uk
brands:
  - id: casino-uk
    name: Casino UK
```

## Hard rule

This plugin **never** binds a `SealedToken` (RG enforcement, KYC writes,
ledger writes, etc.). See `@oss/compliance-invariants` for the list. Attempting
`ctx.provide(RG_SELF_EXCLUSION_SERVICE, ...)` does not typecheck. A
`sealed-fail-demo.ts.skip` file is kept in `src/` (disabled) so the contract
is visible to reviewers.
