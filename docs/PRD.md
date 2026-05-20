# PRD: casino-oss - Open-Source Casino Platform

**Status:** Built (Phases 0-5 complete) + frontend platform consolidated
**Owner:** Krystian + Adam
**Last updated:** 2026-05-20

## Problem Statement

Casino operators today have two choices when building a real-money gaming product:

1. **License a closed, monolithic platform** (Softswiss, EveryMatrix, BetConstruct). Fast time-to-market but the operator never owns the IP, can't see the source, can't extend without vendor cooperation, pays per-license forever, and is locked into the vendor's UI, payment integrations, and roadmap.
2. **Build everything in-house from scratch.** Full ownership, but the table-stakes work (auth, wallet, KYC, RNG, lobby, chat, CMS, compliance reporting) consumes 12-18 months before a single original game ships. Most teams never finish the core and ship a brittle MVP.

There is no middle ground: no headless, plugin-based, OSS casino core that an operator can clone, extend with their proprietary IP (games, brand, UI, regional integrations), and deploy without forking. There's also no equivalent for AI agents to build on - existing platforms have no schema registry, no MCP server, no agent-friendly extension points, so Claude Code / Codex / Cursor can't meaningfully contribute to a casino codebase without a human translating intent into framework-specific incantations.

Concretely, Consumer (the first internal consumer) needs to ship five proprietary PvP games + a sportsbook integration in ~12 weeks, and 80% of the engineering work would otherwise be re-implementing auth + wallet + lobby + chat + bonus + compliance + backoffice. That work is not differentiating.

## Solution

A monorepo containing an OSS, headless, plugin-based casino platform that any team (Consumer first, then external operators) can clone, extend, and deploy. The platform is:

- **Headless.** UI providers are swappable via a contract package (`@oss/ui-provider-contract`). The default adapter is shadcn (`@oss/ui-provider-shadcn`); operators write their own adapter (MUI, Antd, ...) by implementing the same `UIProvider` interface, enforced at compile time. The React platform (`@oss/react-sdk`) ships the typed client, hooks, admin shell, pages, a CSS-variable theme system (per-tenant overridable), and a UI plugin registry - all adapter-agnostic via `useUI()`. The admin is consumed as components mounted in a consumer's own Next.js `app/` directory, not as a forked app.
- **Plugin-based.** Every piece of functionality enters the system through a single `definePlugin({ id, register })` contract. The same contract works for in-tree overlays (`apps/extensions/<name>/`) and externally-published npm packages. Operators never fork core - they drop folders.
- **End-to-end typed.** Zod schemas in one root package are the source of truth. oRPC + NestJS turn them into validated routes, OpenAPI spec, TS-inferred clients, and (optionally) generated REST SDKs for non-TS consumers. There is no manual codegen step for TypeScript callers.
- **AI-native.** Every module ships an `AGENTS.md`. An MCP dev server exposes the schema registry, route catalog, plugin manifest, and code scaffolders as tools. Repo-local slash commands (`/scaffold-module`, `/scaffold-plugin`, `/regen`, `/verify`) call the same code path humans use.
- **Library-shaped for downstream consumers.** A downstream repo (eg `consumer/`) imports `@oss/api-runtime`, calls `createApp({ plugins, contract, ... })`, and gets a fully-configured Nest app. No forking of the OSS API entrypoint. Plugin-host overrides let consumers replace providers (eg swap the mock game provider for Consumer's real engine) without touching OSS code.

The OSS ships 12 modules covering the full table-stakes surface: identity, wallet, gaming, lobby, chat, bonus, compliance, notifications, localization, cms, backoffice, casino-aggregator. Each is replaceable by a plugin. Two worked examples (`examples/consumer-games-plugin/`, `examples/sportsbook-plugin/`) demonstrate the overlay pattern.

## User Stories

### Platform operator (the team running a casino)

1. As a platform operator, I want to clone a working casino backend with auth + wallet + lobby + chat + bonus + compliance + CMS already implemented, so that I can focus on my differentiating IP instead of re-implementing table stakes.
2. As a platform operator, I want to add a new feature (eg "VIP tiers") by dropping a single folder under `apps/extensions/` or `plugins/`, so that I never have to modify or fork OSS core code.
3. As a platform operator, I want to remove a built-in module (eg "chat") by deleting one line from `extensions.config.ts`, so that I only ship the surface area my product actually needs.
4. As a platform operator, I want to override the mock game provider with my real game engine by registering a Nest DI token in my plugin, so that the OSS gaming module works against my proprietary engine without code changes.
5. As a platform operator, I want to add columns to the OSS `User` table (eg `kycLevel`, `referralCode`) via a sanctioned extension API, so that I don't have to fork the Prisma schema and lose upgrade compatibility.
6. As a platform operator, I want to skin the entire admin UI by writing a new UI adapter package, so that I can match my brand without touching the module code.
7. As a platform operator, I want to upgrade to a new OSS version by bumping a single dependency, so that I get bug fixes and new modules without merge conflicts.
8. As a platform operator, I want to consume the OSS as an npm package (not a fork), so that the OSS team can iterate independently.
9. As a platform operator, I want to expose the same API to my mobile app, my third-party affiliates, and my own admin UI through one OpenAPI spec, so that I have one source of truth for all consumers.
10. As a platform operator, I want runtime feature flags so I can turn modules on/off per tenant without redeploying, so that I can A/B test or gradually roll out features. (Deferred to v2.)

### Module author (someone extending the platform)

11. As a module author, I want one canonical `definePlugin({ id, dependsOn, register })` contract for everything that extends the system, so that I don't have to learn three different extension mechanisms.
12. As a module author, I want my plugin's `register(ctx)` function to receive a typed `ModuleRegistry` with explicit hooks (`ctx.providers.add`, `ctx.controllers.add`, `ctx.routers.add`, `ctx.slots.fill`, `ctx.events.on`, `ctx.prisma.extend`, `ctx.mcp.tool`), so that every extension point is greppable and discoverable.
13. As a module author, I want to define my routes as Zod-validated oRPC procedures, so that the OpenAPI spec, TS client types, and runtime validation all come from the same source.
14. As a module author, I want to subscribe to events from other modules (eg `wallet.deposit.completed`), so that I can react to cross-module activity without coupling to their implementation.
15. As a module author, I want to add Prisma tables in my own `prisma.partial.prisma` file, so that I don't have to coordinate schema changes across teams.
16. As a module author, I want a topological dependency resolver to load my plugin after its declared `dependsOn` plugins, so that I can rely on their providers existing at registration time.
17. As a module author, I want a per-module `AGENTS.md` to document my extension points, ports, events, and forbidden patterns, so that other engineers (and AI agents) can extend or compose with my module without reading the source.

### Backend service consumer

18. As a backend service consumer, I want fully type-inferred TS client calls via `@orpc/react-query` or the bare oRPC client, so that I get autocomplete + compile-time guarantees and never have to run a codegen step.
19. As a non-TS service consumer (Go, Python, mobile native), I want an always-current OpenAPI spec at `docs/openapi.json`, so that I can generate a typed client in my language.
20. As a service consumer, I want every endpoint validated at the boundary against the same Zod schema that produced the OpenAPI spec, so that I never receive a response shape that contradicts the spec.

### UI engineer (working in the backoffice or Consumer frontend)

21. As a UI engineer, I want to import components from `@oss/ui-provider-contract` (a contract-only package), so that my pages work against any UI adapter (shadcn, Material, Chakra) without code changes.
22. As a UI engineer, I want plugins to extend the admin (nav items, table columns, dashboard tiles, detail sections, routes) via a typed `defineUIPlugin` registry, so that extensions decorate the shell without my page knowing about them and without forking `@oss/react-sdk` (ADR-0006).
23. As a UI engineer, I want Storybook stories written once against the contract with an adapter switcher in the toolbar, so that the same stories prove every UI adapter (shadcn, MUI, ...) renders correctly - conformance, not duplication.
24. As a UI engineer, I want every visual token exposed as a `--bo-*` CSS variable and a typed `Theme`, so that I can rebrand by passing a `Partial<Theme>` to `<ThemeProvider>` (statically, by named preset, or per-tenant from a DB row) with no rebuild.
25. As a UI engineer, I want to mount the OSS admin pages (`DashboardPage`, `UsersListPage`, ...) as components in my own Next route files, so that I own routing and layout while reusing the platform's pages.

### AI agent (Claude Code, Codex, Cursor)

24. As an AI agent, I want a single top-level `AGENTS.md` declaring architecture pillars, the "where does X go" decision tree, dependency rules, and forbidden patterns, so that I make the same decisions a senior engineer would.
25. As an AI agent, I want `/scaffold-module <name>`, `/scaffold-plugin <name>`, `/scaffold-route <module> <method> <path>`, `/scaffold-ui-component <Name>`, `/regen`, and `/verify` as repo-local slash commands, so that I generate consistent code without inventing my own conventions.
26. As an AI agent, I want an MCP dev server (`apps/mcp-server-dev`) exposing `read-agents-md`, `list-modules`, `describe-route`, `list-extension-points`, `propose-prisma-change`, and `query-openapi` tools, so that I can answer "does X already exist?" before adding duplicates.
27. As an AI agent, I want a `pnpm setup:agent` command that boots Docker + Postgres + Redis + the MCP server in one step, so that a fresh session can become productive in under a minute.
28. As an AI agent, given only the prompt "implement the localization module" in a fresh session, I want to ship a complete, buildable module via `/scaffold-module localization` + MCP tools + AGENTS.md, with at most one or two human confirmations.

### Downstream consumer (Consumer)

29. As a downstream consumer, I want to keep my proprietary game IP in my own private repo, while still reusing the OSS auth/wallet/lobby/chat/compliance/etc, so that my IP stays separate from the OSS codebase.
30. As a downstream consumer, I want a sibling `consumer/` repo to depend on the OSS via `pnpm.overrides` (`link:`) for local dev and via versioned npm tags in production, so that the same dev workflow ships to prod.
31. As a downstream consumer, I want to compose the OSS oRPC contract with my own contract slices (eg `/consumer/vip/*`), so that my API surface is unified but my code is isolated.
32. As a downstream consumer, I want a `createApp(config)` factory that accepts my plugins, my contract, my port, my CORS origins, and (optionally) extra Nest providers, so that my repo's API entrypoint is ~15 lines.
33. As a downstream consumer, I want the OSS schema migrations to flow into my merged `schema.prisma` automatically (via prisma-merge running over both OSS and my partials), so that I never have to manually reconcile DB shape.
34. As a downstream consumer, I want a worked example plugin (`examples/consumer-games-plugin/`) showing the Crash game pattern (custom routes + provider override + event subscription + UI slot injection), so that my engineers have a copy-paste-and-modify template.

### Compliance / security operator

35. As a compliance officer, I want a `compliance` module that gates user actions on configurable deposit / wagering / loss limits (daily / weekly / monthly), so that we meet UKGC + MGA + curacao requirements without custom code.
36. As a compliance officer, I want a geo-block port (with a default IP→country adapter) that can be swapped for MaxMind or any commercial provider, so that we comply with regional restrictions.
37. As a compliance officer, I want all monetary actions (deposits, withdrawals, bets, wins) to emit structured events that an audit-log plugin can consume, so that we have an immutable activity trail.

## Implementation Decisions

### Modules built (12 OSS + 2 platform + 1 host)

**Platform packages (`packages/platform/*`):**

- `plugin-host` - the loader. Owns `definePlugin`, `ModuleRegistry`, topological resolution, and `prisma-merge`. Exposes the canonical extension surface. Deep module: one entry function (`loadPlugins`), simple interface, all complexity encapsulated.
- `api-runtime` - the consumer-facing factory. Exports `createApp(config)`. Wires `InfraModule` + `HealthModule` + `PluginHostModule` + `ORPCModule` and returns an `INestApplication` plus `listen()` / `emitOpenApiSpec()`. Deep module: one entry function, takes a config, returns a running app.
- `core` - shared primitives: logger, `EVENT_BUS` symbol, `InMemoryEventBus` default.
- `persistence` - `PrismaService` (Nest-injectable wrapper) + generated Prisma client.
- `auth` - better-auth integration (used by identity module).
- `events`, `jobs`, `observability` - thin wrappers / type packages.

**Contract packages (`packages/contracts/*`):**

- `domain-schemas` - the single Zod root. All shared types live here.
- `orpc-contract` - root oRPC contract composing 13 slices (one per module + health). Each slice has its own subpath export (`@oss/orpc-contract/wallet`, etc.) so module routers can import only what they need.

**Feature modules (`packages/modules/*`):**

| Module            | Owns                                                                         | Key ports                                   |
| ----------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| identity          | User, Session, Account, Verification tables; register/login/logout/me routes | better-auth, KYC port (future)              |
| wallet            | Wallet, WalletTransaction; balance/deposit/withdraw/transactions routes      | PaymentProvider port                        |
| gaming            | Game, GameRound; list/get/start-round/end-round routes                       | GameProvider port, MockGameProvider adapter |
| lobby             | LobbyCategory, FeaturedSlot; categories/featured/search routes               | reads Game table cross-module               |
| chat              | ChatRoom, ChatMessage; rooms/messages/global routes                          | future: SSE transport                       |
| bonus             | Bonus, UserBonus; available/claim/user-bonuses routes                        | rollover engine                             |
| compliance        | UserLimit, GeoRule; limits CRUD + geo-check routes                           | GeoIpPort                                   |
| notifications     | Notification; list/mark-read/mark-all-read                                   | NotificationDeliveryPort                    |
| localization      | Locale, Translation; locales/translations CRUD                               | i18next compatibility                       |
| cms               | Page, Banner; pages CRUD + banners by placement                              | none                                        |
| backoffice        | (no owned tables - reads cross-module) stats/users/transactions admin API    | none                                        |
| casino-aggregator | AggregatorProvider; sync/providers/callback routes                           | AggregatorProvider port                     |

**Pillar decisions (documented in ADRs):**

- **ADR-0001:** oRPC + NestJS chosen over tRPC + Nest, ts-rest + Nest, oRPC + Hono, Nest + OpenAPI codegen.
- **ADR-0002:** `definePlugin` overlay pattern chosen over decorator auto-discovery, file-system magic, or central plugin registry classes.
- **ADR-0003:** Headless UI provider contract + adapter packages, not direct shadcn coupling.
- **ADR-0004:** Single Zod root in `domain-schemas`, not schemas co-located per module.
- **ADR-0005:** Backoffice ships as headless page components (consumer mounts them), not a forked app. Later consolidated into `@oss/react-sdk` (see ADR's Update note).
- **ADR-0006:** Client-side `defineUIPlugin` UI registry, so plugins extend the admin without forking. Mirrors the server `definePlugin` pattern.

### Contracts and APIs

- **Plugin contract** (the binding interface for the entire system):
  ```
  definePlugin({ id, dependsOn?, register(ctx) }) -> Plugin
  register receives ctx: ModuleRegistry { providers, controllers, routers, slots, events, prisma, mcp, imports }
  ```
- **createApp contract** (the consumer-facing factory):
  ```
  createApp(config: CreateAppConfig) -> Promise<CreatedApp>
  config: { plugins, port?, cors?, databaseUrl?, contract?, openapi?, extraImports?, extraProviders?, disableHealthModule? }
  returns: { app, port, listen(), emitOpenApiSpec(), close() }
  ```
- **Module router contract**: every module exports a Nest `@Controller` decorated with `@Implement(<moduleContract>)` from `@orpc/nest`. Handlers use `implement(<contract>.<procedure>).handler(...)`. No raw `@Get`/`@Post` decorators.
- **Module event namespacing**: every emitted event is prefixed with `<module-id>.*` (eg `wallet.deposit.completed`, `gaming.round.started`). Downstream consumers prefix with their own namespace (`consumer.vip.promoted`).

### Schema strategy

- Each module owns a `prisma.partial.prisma` file. `tools/prisma-merge.ts` concatenates `infra/prisma/base.prisma` + all partials into `infra/prisma/schema.prisma`. The merged file is generated and must not be edited by hand.
- Multi-tenancy is row-level: every module-owned table has a `tenantId String` column. The `withTenant` helper in `@oss/persistence` scopes queries.
- Decisions about extending OSS tables from a consumer plugin:
  - **Preferred:** consumer creates a derivative table with a FK to the OSS table (eg `ConsumerUserProfile` FK to `User`).
  - **Sanctioned:** `ctx.prisma.extend('User', 'kycLevel String?')` registers the column with the prisma-merge step. Honored by the merger (deferred - currently the registry accepts the call but the merger doesn't yet apply it).
  - **Forbidden:** editing `infra/prisma/schema.prisma` directly.

### Boundary rules (enforced by lint)

- `packages/modules/*` may not import from each other - cross-module talk goes through `@oss/orpc-contract` (for types) or events.
- `packages/platform/*` may not import from modules.
- `apps/extensions/*` and downstream consumer plugins may import any `@oss/*` package, but never another extension.
- `apps/api` only registers modules via `extensions.config.ts`. A direct module import from `apps/api/src/*` is a lint error.

### Downstream consumer model (Consumer sibling repo)

- Consumer is a sibling directory (`consumer/`) to `casino-oss/`, not a fork.
- `consumer/package.json` uses `pnpm.overrides` with `link:../casino-oss/packages/*` for local dev.
- Consumer has its own `extensions.config.ts` referencing OSS modules by path AND its own plugins (eg `vip-tiers/`).
- `consumer/apps/api/src/main.ts` is ~15 lines calling `createApp({ plugins, contract, port: 3101, ... })`.
- In production, the `link:` paths are swapped for versioned npm tags. No code change needed.
- Worked example `examples/consumer-games-plugin/` (Crash game in OSS examples folder) demonstrates the pattern in the OSS repo itself.

### AI agent infrastructure

- Repo-root `AGENTS.md` is the canonical brief; `CLAUDE.md`, `.cursorrules`, `.github/copilot-instructions.md` are generated from it via `tools/sync-agent-docs.ts`.
- Per-module `AGENTS.md` documents extension points, ports, events, do/don't.
- `apps/mcp-server-dev` exposes the schema registry, route catalog, plugin manifest, and scaffolders as MCP tools.
- `.claude/skills/*` are repo-local slash commands. `.claude/agents/*` are repo-local subagent personalities (`oss-module-author`, `plugin-author`, `contract-reviewer`, `ui-provider-author`).
- 4 ADRs at `docs/adr/` document settled questions so agents don't re-litigate them.

## Testing Decisions

### What makes a good test in this codebase

- **Test external behavior, not implementation.** A `wallet.service.test.ts` asserts that `deposit(userId, 100)` results in a new transaction row with status `completed` and a balance increase of 100. It does NOT assert "the service called prisma.walletTransaction.create with these specific args".
- **Integration tests use a real Postgres** (via `@oss/infra db:up`). Mocks of the database are forbidden per the architecture pillar "explicit > magic" - mock/prod divergence is a known incident pattern in casino billing systems.
- **Service-level unit tests** mock only the adapter ports (PaymentProvider, GameProvider, GeoIpPort). Everything else is real.
- **Router-level tests** assert that an HTTP request producing valid input returns the expected output and that domain errors map to the correct oRPC error codes (NOT_FOUND, FORBIDDEN, CONFLICT).
- **Contract tests** assert that the emitted OpenAPI spec matches a committed snapshot - any unintended contract drift fails CI.

### Modules to write tests for (in priority order)

1. **plugin-host** - deepest module, lowest test count today. Topological sort, dependency cycle detection, `register(ctx)` invocation order, prisma-merge file output. Pure functions; ideal for unit testing.
2. **api-runtime** - one end-to-end test that boots `createApp({ plugins: [] })`, hits `/health`, and confirms the response shape. Catches regressions in the factory contract.
3. **wallet** - real-money handling; highest blast radius. Test sufficient-balance enforcement, double-spend race conditions (with real Postgres + transactions), event emission on success.
4. **bonus** - rollover math. Test that `wageredAmount` accumulates correctly and `claimBonus` doesn't double-award.
5. **compliance** - geo-check + limit enforcement. Test that exceeding daily deposit limit blocks the action.
6. **identity** - register/login flows. better-auth handles most edge cases; test our wrapper.

The other 6 modules (gaming, lobby, chat, notifications, localization, cms, backoffice, casino-aggregator) currently have smoke tests covering domain error classes only. That is acceptable for v1; expand as bugs surface.

### Prior art for tests

- Existing service tests (`packages/modules/*/src/__tests__/*.service.test.ts`) are smoke tests asserting domain error classes throw the right shape. Pattern to copy: pure constructor-injection with mocked PrismaService, test against returned values + thrown error types.
- No integration tests exist yet. The first integration test should establish the `@oss/infra db:up` + Prisma `migrate dev` + truncate-between-tests pattern; subsequent integration tests follow.
- E2E test of the worked example: spin up `examples/consumer-games-plugin/` overlaid on the OSS, confirm `POST /crash/bets` creates a row and `POST /crash/cash-out` settles it. This validates the entire plugin pipeline end-to-end.

## Out of Scope

The following are intentionally NOT delivered in this PRD and tracked separately:

- **Real payment provider integrations.** OSS ships a mock `PaymentProvider`. Stripe, Worldpay, Coinbase Commerce, etc. live in operator-specific plugin packages.
- **Real game engine.** OSS ships a `MockGameProvider`. Consumer's PvP games live in `consumer/plugins/*`, not in OSS.
- **Real sportsbook integration.** `examples/sportsbook-plugin/` shows the shape but the Betby/Kambi adapter is a stub.
- **KYC integration** (Sumsub, Onfido, Jumio). Identity module exposes a hook; the actual adapter is operator-specific.
- **AML transaction monitoring** (Chainalysis, Elliptic). Future module.
- **Native mobile apps.** OSS provides the API + OpenAPI; mobile teams generate their client.
- **Live dealer / streaming integration.** Out of v1 OSS scope.
- **Multi-currency conversion / FX.** Wallet currency is per-wallet today; FX rate management is operator-specific.
- **Live chat customer support tools** (Intercom, Zendesk). Notifications module has a delivery port that can be wired up later.
- **Geo-IP database.** The `GeoIpPort` interface is provided; the actual MaxMind / IP-API integration is operator-specific.
- **Server-side LLM features** (auto-moderation, AI chat assistant). The `packages/llm/*` tree was scoped out of v1.
- **Runtime feature flags.** Static enable/disable via `extensions.config.ts` exists; dynamic per-tenant flags deferred to v2.
- **Native multi-tenancy beyond row-level `tenantId`.** Schema-per-tenant and database-per-tenant are out of scope.
- **gRPC / GraphQL transports.** oRPC + REST/OpenAPI only.
- **Mobile push notification adapter.** Notification port exists; APNs/FCM adapters are operator-specific.

## Further Notes

### Phase status

- Phase 0 - AI infrastructure: done
- Phase 1 - Cleanup: done
- Phase 2 - Spine (plugin-host, oRPC+Nest, UI provider): done
- Phase 3 - First vertical (identity module as reference): done
- Phase 4 - Module rollout (remaining 11 modules): done
- Phase 5 - Examples + extension demos: done
- Post-phase refactor: `createApp` factory pattern landed, Consumer consumer scaffolded
- Frontend platform: Consumer `apps/web` consumes the OSS admin at `/admin/*`; headless backoffice + typed client + theme system consolidated into `@oss/react-sdk` (former `@oss/client`, `@oss/backoffice-ui`, `@oss/design-system` removed); UI plugin registry (ADR-0006) shipped with `vip-tiers` as first consumer; Storybook refactored to contract-driven + adapter switcher; Docker reference stack + one-command `pnpm setup` for Consumer; end-to-end auth flow (register/login/cookie session/logout) working.

### What's blocking first boot

- pnpm 9 is installed locally but the project requires `pnpm@10`. User must upgrade before `pnpm install` succeeds. Single command: `npm install -g pnpm@latest`.
- Pre-existing TS1479 ESM-interop errors across modules using `@orpc/*` (which are ESM-only) compiled under Node16 module resolution. The errors don't block runtime under `tsx` but should be resolved in tsconfig before production. Tracked separately.

### Known follow-ups

- Honor `ctx.prisma.extend()` in `prisma-merge.ts` so downstream consumers can decorate core tables. The registry accepts the calls today; the merger ignores them. (Blocks the backoffice's `role`/`isActive` admin fields, which the better-auth `user` table doesn't yet have.)
- ~~Add a thin `createBackofficeApp({ uiAdapter, ... })` factory~~ - superseded. The admin ships as headless components from `@oss/react-sdk`; the consumer mounts them and swaps the adapter via `<UIProvider>`. No factory needed.
- Build a second UI adapter (`@oss/ui-provider-mui` or similar) to exercise the adapter-swap path and validate the contract is truly library-agnostic. The Storybook adapter switcher is ready for it.
- Server-side data prefetch for admin pages (RSC + TanStack Query hydration) - needs cookie-forwarding plumbing in the runtime; pages fetch client-side today.
- Per-tenant theme persistence: a `theme` API/table returning a `Partial<Theme>` per casino, wired to `<ThemeProvider theme={...}>`.
- Typed client for consumer-defined routes: let a downstream consumer compose its own oRPC contract with the OSS one so plugin routes (eg `/consumer/vip/*`) get the same `z.infer` typing the core routes have. Today plugin UI calls those via the raw `useApiClient()`.
- Add dynamic feature flags as a regular module + port (default DB-backed adapter; can swap for LaunchDarkly/Unleash/PostHog).
- Wire eslint-plugin-boundaries to enforce the dependency rules at lint time, not just by convention.
- First integration test against real Postgres for the wallet module.
- `pnpm sync:agent-docs` keeps `.cursorrules` / Copilot instructions in sync with `AGENTS.md` - verify it still works after the Phase 4 changes.

### Acceptance criteria for "v1.0 released"

- A fresh Claude Code session, given only the prompt "implement a tournament module" in the casino-oss repo, ships a buildable module via `/scaffold-module tournament` + MCP tools + AGENTS.md, with at most two human confirmations.
- `cd consumer && pnpm setup && pnpm dev` brings up the API on `:3101` and the web app on `:3100`, including the OSS modules, the local VIP tiers plugin (server + UI), and the OSS admin mounted at `/admin/*`.
- An external operator can fork the consumer pattern from `examples/` and have a brand-skinned (via `<ThemeProvider>` + UI adapter), branded-routed, branded-database casino API + admin running in under a day.
