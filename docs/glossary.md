# Glossary

Shared vocabulary for this repo: the **roles** (who's who), the **platform/architecture** terms, and the **iGaming domain** terms. When a term maps onto a concrete part of the codebase, the last column points to it.

> **Read this first - the word "user" is ambiguous in iGaming.** In igaming UIs "user" usually means the gambler. In this repo we avoid the bare word: **operator / consumer / end user** = the developer or company that installs the OSS packages and builds a igaming; **player** = the gambler who registers, deposits, and plays. Keep them distinct.

## Roles - who's who

| Term                                                                 | Who it is                                                                                                                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Operator** / **consumer** / **downstream consumer** / **end user** | The developer or company that installs the `@oss/*` packages and builds + runs their own igaming. They are the "end user" of the _package_, not a gambler. They bring their own `extensions.config.ts`, UI adapter, and vendor adapters. |
| **Player**                                                           | The person who registers on an operator's igaming, deposits funds, and plays. The operator's customer. Modeled by the `player` module + auth `User`.                                                                                     |
| **Admin** / **backoffice user**                                      | Operator staff who manage players, approve withdrawals, configure games, and edit content via the backoffice. A role on the auth `User`, not a separate person type.                                                                     |
| **Maintainer** / **core contributor**                                | Someone working on the OSS platform itself (this repo) - distinct from an operator who only consumes it.                                                                                                                                 |

## Platform & architecture terms

| Term                                     | Meaning                                                                                                                                                                                                                                       | Maps to                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Headless**                             | The platform ships backend only - modules, contracts, API, and SDK consumption surface. The operator supplies the entire frontend (pages, components, styling, theme) in their own repo.                                                      | `packages/modules/*`, `@oss/react`                                       |
| **Module**                               | A business domain packaged as an independently loadable unit (auth, wallet, gaming...). Never imports another module.                                                                                                                         | `packages/modules/<name>/`                                               |
| **Plugin** / **extension** / **overlay** | A drop-in unit that adds or overrides behavior via `definePlugin({ id, register })`. The only way new functionality enters the system.                                                                                                        | `apps/api/src/extensions/*`, consumer plugins                            |
| **Adapter**                              | The vendor-agnostic interface a module depends on (e.g. `KycAdapter`, `PaymentAdapter`) plus its per-vendor implementations. The swap seam: a module declares the interface + DI token in `@oss/adapters`; an operator binds a concrete impl. | `@oss/adapters` + `modules/<m>/adapters/<vendor>/`                       |
| **Contract**                             | The composed oRPC router. Drives request validation, the typed client, and the emitted OpenAPI spec.                                                                                                                                          | `@oss/orpc-contract`                                                     |
| **Domain schema**                        | A Zod schema - the single source of truth for a shape. Types are `z.infer`'d, never hand-written.                                                                                                                                             | `@oss/shared-schemas`, module `schemas/`                                 |
| **UI plugin**                            | A client-side extension that customizes the look/feel. Lives in the consumer frontend, not in this repo. The platform is headless backend only.                                                                                               | ADR-0013 (superseded)                                                    |
| **Slot**                                 | A typed injection point in a UI surface that a plugin can fill. Owned by the consumer frontend.                                                                                                                                               | ADR-0013 (superseded)                                                    |
| **Sealed token**                         | A `SealedToken<T>` whose backing service operators may never override (RG enforcement, KYC writes, AML/SAR, ledger writes, RNG, etc.). Structurally incompatible with `Token<T>` + runtime-rejected by plugin-host.                           | `@oss/compliance-invariants`                                             |
| **Client page token**                    | `ClientPageToken<P>` - Tier 3 escape hatch for full client-side page replacement.                                                                                                                                                             | `@oss/adapters/token.ts`                                                 |
| **Brand scope**                          | Multi-brand operators define brands in `PlatformConfig.brands`; `<ThemeProvider activeBrand="...">` selects the active one; slot fills with `brandScope: [...]` render only when the active brand matches.                                    | ADR-0013 T0.5                                                            |
| **Platform config**                      | Operator-editable Zod-validated YAML/JSON consumed at boot. Controls feature flags, brands, RG defaults per geo. No admin UI in v1.                                                                                                           | `@oss/shared-schemas/platform-config.ts`, `@oss/core/loadPlatformConfig` |
| **Tenant** / **multi-tenant**            | A logical isolation boundary; every scoped row carries `tenantId` and is read via `withTenant`.                                                                                                                                               | `@oss/db`                                                                |
| **Scaffold**                             | A deterministic code-mod that stamps a module/plugin/route/component skeleton.                                                                                                                                                                | `tools/gen.ts`, `/scaffold-*`                                            |
| **MCP dev server**                       | A stdio tool server agents connect to for read-only inspection + scaffolding.                                                                                                                                                                 | `apps/mcp-server-dev`                                                    |
| **RGS** (Remote Gaming Server)           | The game engine that runs rounds, applies RTP, and settles bets. Can be third-party (a provider) or the platform's own multiplayer/provably-fair foundation.                                                                                  | `gaming` module + `GameAdapter`                                          |

## iGaming domain terms

### Identity & compliance

| Term                             | Meaning                                                                                                                               | Maps to                       |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **KYC** (Know Your Customer)     | Verifying a player's identity (ID/selfie/proof of address), usually via a third-party provider, before withdrawals above a threshold. | `identity` / `KycAdapter`     |
| **AML** (Anti-Money Laundering)  | Controls and monitoring to detect/prevent laundering through play (limits, source-of-funds, suspicious-activity flags).               | `identity`, `compliance`      |
| **2FA**                          | Two-factor authentication (TOTP) on a player or admin account.                                                                        | `identity` (better-auth)      |
| **Geo-blocking**                 | Refusing service from restricted jurisdictions based on IP/region.                                                                    | `compliance` / `GeoIpAdapter` |
| **Jurisdiction** / **licensing** | The regulatory regime a igaming operates under; dictates allowed countries, game rules, RG requirements, and reporting.               | operator concern              |

### Wallet & payments

| Term                               | Meaning                                                                                                                | Maps to                     |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| **Wallet**                         | A player's balance(s) and the ledger of money movements.                                                               | `wallet` module             |
| **Balance**                        | Spendable funds, shown in real time; may differ from pending.                                                          | `wallet`                    |
| **Deposit** / **withdrawal**       | Money in / money out, in fiat or crypto.                                                                               | `wallet`                    |
| **PSP** (Payment Service Provider) | A fiat payment vendor (card, bank, e-wallet) integrated behind an adapter.                                             | `wallet` / `PaymentAdapter` |
| **Fiat** / **crypto**              | Government currency (USD, EUR...) vs cryptocurrency (BTC, ETH, USDT...). The platform supports multi-currency display. | `wallet`                    |
| **Transaction history**            | The filterable record of deposits, withdrawals, bets, wins, and transfers.                                             | `wallet`                    |
| **Chargeback**                     | A reversed card payment a player disputes with their bank; a fraud/risk concern for the operator.                      | operator concern            |

### Games & fairness

| Term                         | Meaning                                                                                                                                                                                                            | Maps to                                    |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| **Game provider**            | A studio/vendor supplying games, integrated behind an adapter.                                                                                                                                                     | `gaming` / `GameAdapter`                   |
| **Aggregator**               | A single integration that fans out to many game providers' catalogues.                                                                                                                                             | `igaming-aggregator` / `AggregatorAdapter` |
| **Sportsbook**               | Sports-betting product (e.g. Betby), integrated as a large isolated domain/plugin.                                                                                                                                 | operator plugin                            |
| **Game round** / **session** | One play cycle (bet -> result -> settle); a session groups rounds for a player at a game.                                                                                                                          | `gaming`                                   |
| **Lobby**                    | The browsable surface of games: categories, featured slots, search, recent activity.                                                                                                                               | `lobby`                                    |
| **RTP** (Return To Player)   | The long-run % of stakes a game pays back (e.g. 96%). The complement is the **house edge**.                                                                                                                        | game config                                |
| **House edge**               | The operator's expected margin (100% - RTP).                                                                                                                                                                       | game config                                |
| **Provably fair**            | A scheme letting players verify a result wasn't tampered with: a **server seed** is committed (hash published) before the round, combined with a **client seed** and a **nonce**, then revealed for recomputation. | `gaming` (foundation)                      |

### Bonuses & engagement

| Term                                    | Meaning                                                                                         | Maps to                              |
| --------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------ |
| **Bonus**                               | Promotional credit (welcome bonus, deposit match, free spins).                                  | `bonus` module                       |
| **Wagering requirement** / **rollover** | How many times bonus (or gifted) funds must be wagered before they can be withdrawn (e.g. 30x). | `bonus`                              |
| **VIP tiers**                           | Loyalty levels granting perks based on activity (a downstream extension, not core).             | consumer overlay under `extensions/` |
| **Affiliate**                           | A partner who refers players for a revenue share.                                               | operator concern                     |

### Responsible gaming

| Term                              | Meaning                                                  | Maps to      |
| --------------------------------- | -------------------------------------------------------- | ------------ |
| **Responsible gaming (RG)**       | Player-protection features required by most regulators.  | `compliance` |
| **Deposit / loss / wager limits** | Player-set or mandated caps over a period.               | `compliance` |
| **Self-exclusion**                | A player blocking themselves from play for a set period. | `compliance` |

### Content, social & business

| Term                          | Meaning                                                                                                                                                    | Maps to                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| **CMS**                       | Operator-managed static pages and banners (T&C, FAQ, promos).                                                                                              | `cms` module                                    |
| **Notifications**             | In-app + email events (deposit confirmed, withdrawal status, bonus credited...).                                                                           | `notifications` / `NotificationDeliveryAdapter` |
| **Chat**                      | Global and in-game messaging with soft moderation.                                                                                                         | `chat` module                                   |
| **Tip** / **gift** / **rain** | Player-to-player money mechanics in chat (tip one player; drop a claimable gift; "rain" a split across many). Consumer-specific social features, not core. | consumer plugin                                 |
| **GGR / NGR**                 | Gross / Net Gaming Revenue (stakes minus wins; NGR also nets bonuses/fees). The core operator KPI.                                                         | analytics                                       |
