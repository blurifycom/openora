# TODO

Punch list of known gaps. Last audited: 2026-05-28. Each item has a severity, the file paths involved, and a one-line fix sketch.

Severity legend: **P0** = blocks real-money launch / breaks documented flow, **P1** = makes the docs lie / breaks an agent path, **P2** = quality / polish.

## 1. Operator onboarding

| # | Severity | Gap | Fix sketch |
|---|---|---|---|
| 1.1 | P0 | `tools/templates/variants/web-next/` still imports `@oss/react-sdk` in 8 files - `pnpm create:app` generates a broken consumer | mass-replace `@oss/react-sdk` -> `@oss/react-pages` in template files |
| 1.2 | P1 | `pnpm create:app` requires a separate `pnpm build:oss` first; not documented in the template's README | document in template README + scripts in `package.json.tpl` |
| 1.3 | P1 | `tools/setup-agent.ts` reads `packages/platform/db/.env.example` which may not exist; swallows migrate failure as "normal" | verify the env file path, surface migrate failure with actionable error |
| 1.4 | P1 | Consumer agent `packages/platform/mcp/agents/igaming-builder.md` references MCP tools `catalog-overview` and `list-adapters` that the dev server does not expose | either add those tools to `apps/mcp-server-dev/src/main.ts` or rewrite the agent to use existing tool names |
| 1.5 | P2 | Consumer template `package.json.tpl` is missing `pnpm regen` script | add `regen` script to the template |

## 2. Agent-friendliness (slash commands + skills)

| # | Severity | Gap | Fix sketch |
|---|---|---|---|
| 2.1 | P1 | `.rulesync/commands/scaffold-module.md` references Prisma (`prisma partial`, `*.partial.prisma`) - project is on Drizzle | rewrite for Drizzle + `pnpm regen`, then `pnpm sync:agents` |
| 2.2 | P1 | `.rulesync/commands/scaffold-plugin.md` imports from `@oss/react-sdk` (removed) | replace with `@oss/react-pages` / `@oss/react-hooks`, then `pnpm sync:agents` |
| 2.3 | P1 | `.rulesync/commands/scaffold-ui-component.md` references `@oss/react-sdk` | same fix |
| 2.4 | P1 | `.rulesync/commands/regen.md` is an entire Prisma workflow description | rewrite for `drizzle-kit generate` + `pnpm -F @oss/db generate`, then `pnpm sync:agents` |
| 2.6 | P2 | No `AGENTS.md` in `apps/api`, `apps/web`, `apps/backoffice`, `packages/sdks/sdk-core`, `packages/sdks/plugin-test-kit` | add minimal AGENTS.md briefs |

## 3. UI extensibility (v1.1 wiring)

| # | Severity | Gap | Fix sketch |
|---|---|---|---|
| 3.1 | **P0** | `SlotEvaluationContextProvider` is never mounted in `packages/sdks/react-pages/src/oss-providers.tsx`. Every fill with `featureFlag` / `requiresPermission` / `brandScope` falls back to the empty default and is silently invisible. The entire v1.1 gating model is inert. | wrap children in `SlotEvaluationContextProvider` inside `OssProviders`; accept `permissions` / `brand` / `features` props or derive them from session + theme + PlatformConfig |
| 3.2 | P1 | `@oss/example-vip-tier` does not call `usePageContext` or `useDataExtension` - only mentioned in JSDoc. `VipSection` takes `playerId` as a prop. | rewrite `VipSection` to consume `usePageContext<PlayerDetailContext>()`; add a real `useDataExtension('vip-tier', 'tier', fetcher)` call |
| 3.3 | P1 | The reference plugin is not registered anywhere - not in `extensions.config.ts`, not in `apps/backoffice/src/providers.tsx` (`plugins: UIPlugin[] = []`), not in `apps/web/app/providers.tsx` | wire it in both providers behind a `NODE_ENV !== 'production'` guard so default builds aren't polluted but the demo path is live |
| 3.4 | P2 | `sealed-fail-demo.ts.skip` is referenced in the reference plugin header but does not exist | add the file with `@ts-expect-error - sealed` + a comment, as ADR-0013 verification step calls out |
| 3.5 | P2 | `ClientPageToken<P>` type exists in `packages/contracts/adapters/src/token.ts` but is unused - no T3 reference override | ship at least one toy `ADMIN_USERS_PAGE` override in the example plugin |
| 3.6 | P2 | Boundary lint missing rules: `no-cross-extension-import` (claimed in `apps/api/src/extensions/README.md`) and an `@oss/ui-provider-daisyui`-import-in-modules rule | add both to `tools/oxlint-boundaries-plugin.mjs` |

## 4. API extensibility

| # | Severity | Gap | Fix sketch |
|---|---|---|---|
| 4.1 | P0 | No RNG adapter token, despite ADR-0013 and audits requiring an RNG swap seam. Sealed token exists; swappable adapter contract does not. | add `packages/contracts/adapters/src/rng.ts` with `RngAdapter` + `RNG_ADAPTER` token + default deterministic mock |
| 4.2 | P1 | `apps/api/src/extensions/` is empty of real overlays - only README + AGENTS.md. No working example of route addition, adapter swap, event subscription, or table contribution. | port `example-vip-tier` server half into `apps/api/src/extensions/vip-tier/plugin.ts` as a smoke-tested overlay |
| 4.3 | P1 | `packages/modules/player/aggregator/src/plugin.ts` does not bind a default `AGGREGATOR_ADAPTER` - any caller crashes at boot unless an overlay binds one | provide a `MockAggregatorAdapter` default |
| 4.4 | P2 | Server-side `ctx.slots.fill(slotName, component)` on `ModuleRegistry` overwrites prior value, is unused anywhere, and is distinct from the React `Slot` system - dead surface | remove or document why it exists |

## 5. Compliance and production safety

These are the launch blockers for real-money operation. All P0 unless noted.

| # | Severity | Gap | Notes |
|---|---|---|---|
| 5.1 | P0 | None of the 12 sealed compliance tokens have implementations. `SEALED_TOKENS` in `packages/contracts/compliance-invariants/src/sealed.ts` is declared; zero hits across `packages/modules`. The runtime guard only refuses to **bind** them - nothing binds them either. | each sealed token needs a default impl bound under a platform-internal token that the public sealed token aliases to, OR a separate locked module that owns it |
| 5.2 | P0 | Wallet `deposit()` / `withdraw()` has no idempotency key. Two parallel `POST /wallet/deposit` calls = double credit. | add `idempotencyKey` to `DepositInputSchema`, persist + check before ledger write |
| 5.3 | P0 | Wallet does not call `compliance.geoCheck()`, KYC status, self-exclusion, or RG limits before crediting | inject `KycAdapter`, `GeoIpAdapter`, sealed RG service; check before write |
| 5.4 | P0 | Only PSP is `MockPaymentAdapter`. No Stripe / Worldpay / Adyen / PaySafe reference impl. | ship at least one real adapter behind an env flag, or document loudly that one is mandatory before launch |
| 5.5 | P0 | No GDPR data-export (Art 15) or erasure (Art 17) endpoint. Zero hits for `gdpr` / `dataExport` / `forgotten`. | add a `gdpr` module with `exportPlayerData` + `eraseRequest` flow + sealed `GDPR_DATA_RIGHTS_WORKFLOW` token impl |
| 5.6 | P0 | No date-of-birth / age-verification field in identity. Minors can register. | add DOB to register schema; bind `AGE_VERIFICATION_GATE` sealed-token impl |
| 5.7 | P0 | No geo platform-deny defaults; `GEO_IP_ADAPTER` has no default binding so `compliance.geoCheck()` returns allowed for everything | ship a default `GeoIpAdapter` with OFAC / sanctions baseline + configurable allow-list |
| 5.8 | P0 | No audit log writer implementation. `AUDIT_LOG_WRITER` token exists; no table, no consumer. Regulator audit trail is empty. | add audit log Drizzle table + writer service + bus subscriber for sensitive events |
| 5.9 | P1 | No 2FA, password-reset rate limiting, or forced-logout-on-self-exclusion verified | extend better-auth integration with these flows |
| 5.10 | P1 | `seedDemoData` (`tools/seed.ts`, exported from `@oss/api-runtime`) ships `admin@oss.dev / password123` with no env gate. Operator could wire it into staging by accident. | refuse to run unless `process.env.NODE_ENV !== 'production'` AND `process.env.ALLOW_DEMO_SEED === '1'` |
| 5.11 | P1 | Unit tests don't exercise the money path. 13 test files / 674 LOC; `wallet.service.test.ts` is 19 lines testing error message strings only. | see section 6 |

## 6. Testing + publishing - user-requested explicit TODO

### 6.1 E2E tests (P0 before any real-money launch)

Today: zero Playwright tests, no integration coverage of the money path, no coverage of the auth flow, no coverage of the plugin loading order.

Minimum E2E suite to ship:

| Surface | Critical paths |
|---|---|
| Player | register -> KYC submit -> deposit -> bet -> withdraw; self-exclusion flow; deposit-limit cooling; bonus claim + wagering |
| Admin | login -> player list -> player detail -> manual KYC approve / reject; manual deposit / withdrawal review; audit log read |
| Plugin | overlay loads, contributes route, swaps adapter (assertion: last-binding-wins); overlay contributes UI slot fill (assertion: gating props evaluated); sealed-token typecheck fail demo |
| API | every endpoint returns the Zod-shape it declares; auth gate on every admin route |

Test infra:
- `@oss/plugin-test-kit` already ships `validatePlugin` - extend with a Playwright `mountWithPlugin` helper (already drafted in the plan, not implemented).
- Playwright config + a `pnpm test:e2e` script gated in `pnpm verify` so PRs cannot regress.
- A real ephemeral Postgres per spec (use `pnpm db:reset` between specs) - no mocks for the ledger.

### 6.2 Publishing (P0 before any external operator can consume)

Today: every `@oss/*` package is consumed via `link:` from a sibling checkout. There is no publish pipeline. A real downstream operator cannot `pnpm install @oss/api-runtime`.

Two-step plan:

**Step A - private GitLab registry (short-term, internal)**

| Task | Why |
|---|---|
| Set up GitLab project-level npm registry for the OSS group | gives Consumer + other early operators a stable installable instead of `link:` |
| Add `publishConfig.registry` to every public package's `package.json` | route publish to GitLab |
| Add a `release` workflow (changeset or semantic-release) running on tag push | automate version bumps + changelog |
| Document in `docs/downstream-consumer.md` how an operator switches from `link:` to the registry version | the upgrade story |

**Step B - public npm (mid-term, when stable)**

| Task | Why |
|---|---|
| Reserve `@oss` (or rename to a free scope, e.g. `@example-oss`) on npmjs.com | the current `@oss` scope is already taken on npm; will fail at publish |
| Audit `publishConfig.access: "public"` on every package | npm scoped packages default to private |
| CI workflow publishing on tag + Sigstore attestation | supply-chain hygiene |
| Add `provenance: true` to the publish workflow | npm provenance for trust |

**Open question**: the `@oss` scope on npm is already owned. We have to either negotiate it, switch scope, or publish under the operator scope (`@example/...`). Decide before Step B.

## 7. Cleanup / housekeeping (P2)

| # | Gap | Fix |
|---|---|---|
| 7.1 | `packages/sdks/react-sdk/` has uncommitted modifications in `git status` but the directory should be deleted per ADR-0013 | confirm delete is complete and commit |
| 7.2 | `docs/openapi.json` and `docs/CATALOG.md` are generated - confirm CI's `verify:drift` catches stale commits | already configured per `package.json:25` |
