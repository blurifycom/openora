# ADR-0033: Analytics as a Read-Only CQRS Domain

**Date**: 2026-07-25
**Status**: Accepted

## Context

A financial-analytics dashboard is requested (deposits/withdrawals by
currency and rail, net revenue, bonus cost, a GGR trend) and a registration-to-first-bet
conversion funnel, both filterable by date range and currency. No module in
`packages/core/src` computes any of this today - the closest thing, `admin-console`'s
`GET /backoffice/stats`, hardcodes `totalBonusClaimed: '0'` and stubs `activeUsers` to
`totalUsers`.

The data needed spans three existing domains: `wallet` (deposits, withdrawals, bonus,
bet/win transactions), `pam/identity` (registration, email verification), and
`pam/profile` (player records). None of them owns the _reporting_ concern, and none
should grow one - `admin-console`'s `AGENTS.md` is explicit that it owns no tables and
stays port-pure, and folding a cross-cutting read model into any single domain (wallet
being the obvious candidate, since most of the data lives there) would make that
domain's `AGENTS.md` lie about its own scope the moment a dashboard shell or
game/player analytics needs the same treatment for casino/gaming data.

Alternatives considered:

- **A slice under `wallet` (`wallet/analytics`)** - no new domain, reuses the existing
  export surface. Rejected: financial data is one thing analytics reports on, not what
  it is: the conversion funnel is a `pam/identity` + `wallet` join with no wallet
  ownership at all, and per-game analytics has nothing to do with wallet
  either. Housing it there is a naming lie that gets more wrong with every added report.
- **Port-only, no direct schema reads** (`admin-console` stays the caller, each owning
  domain implements an `ANALYTICS_*` port) - the most "orthodox" hexagonal shape. Rejected
  as needless indirection for a _read-only reporting_ concern: a command port exists
  to let an owner control how its state is mutated or to keep a synchronous
  cross-module answer swappable; reporting queries are neither. Splitting one dashboard's
  logic across three port implementations, three test suites, and a caller that just
  glues them together adds files and interfaces without adding a real seam - the
  actual constraint (never sum across currencies, cohort semantics) has to live
  _somewhere_ real, and scattering it across three adapters makes it harder to review as
  one invariant, not easier.
- **A consumer-local overlay plugin** - fastest to ship, but the feature is platform-generic
  (any igaming operator wants financial + funnel reporting), so it would be rebuilt for
  the next consumer instead of shipping in `@openora/core`.

## Decision

`packages/core/src/analytics/` becomes a 10th top-level folded domain, module id
`analytics`, published as `@openora/core/analytics` (+ `/plugin`, `/contract`,
`/server`). It owns **zero tables** - it is the CQRS read side over data other domains
own, reached only through their published, read-only `/schema` subpaths
(`@openora/core/wallet/schema`, `@openora/core/pam/schema/identity`,
`@openora/core/pam/schema/profile`), the same sanctioned "cross-module schema read"
the boundary rules already allow (warned, not banned, by
`no-cross-addon-schema-read` - each one is a noted extraction blocker, not a violation).

Two contract slices ship under the one domain: `financial` (`/analytics/financial/summary`,
`/analytics/financial/ggr`) and `funnel` (`/analytics/funnel/conversion`). Every route
guards on the existing `analytics` permission resource (already granted to `admin` and
`support` in the static role table, already used by `pam/player-management`'s stats
routes) and reads through the `CACHE` port with a short TTL - these are dashboards on a
refresh interval, not a real-time feed.

Because the platform has no FX rates anywhere (`platform-config`'s `currencies` is a
plain list, no rate table), every money output is grouped by currency and never summed
across currencies - a constraint that has to be enforced once, in one place, rather than
re-derived per report.

`SERVICE_MANIFEST=analytics` can already run this domain as its own process against a
read replica with zero code change (the manifest mechanism, ADR-0017, works on any
module id) - the domain earns "CQRS read side" as more than a label.

## Consequences

**Positive:**

- A dashboard shell and game/player analytics get an obvious, correctly-named
  home to land beside, instead of a second wallet-shaped lie or a second overlay.
- The "never sum across currencies" and "cohort, not event-in-range, funnel" invariants
  live in exactly one `AGENTS.md` and one set of services, not scattered across three
  port implementations.
- No new tables, no new migration risk, no write path to get wrong - the entire domain
  is additive and reversible (delete the plugin entry, the routes disappear).

**Negative / trade-offs:**

- A 10th domain grows the map every agent and reviewer has to hold in their head, and
  costs a new `core-plugins.ts` entry + four `package.json` export entries for what is,
  today, three routes.
- Cross-domain schema reads (three of them) are each a noted future extraction blocker
  per `no-cross-addon-schema-read` - acceptable now, revisited if any of wallet/identity/
  profile is ever split into its own service ahead of analytics.
- `game_round.betAmount` is now persisted (`casino/gaming` debits the stake via
  `WALLET_COMMANDS` at round start), but `winAmount` stays unwritten - crediting a win
  is regulated game-outcome/RTP territory gated by the sealed, unimplemented
  `GAME_OUTCOME_AUTHORITY` token, not something to fake through a mock adapter. GGR is
  computed from `wallet_transaction` (`bet` minus `win`) rather than from `game_round`,
  and per-game GGR still needs a certified outcome authority before it can
  exist.

**Neutral:**

- Relates to ADR-0021/0025 (domain folding into `@openora/core` subpaths), ADR-0017
  (command ports, service manifest), ADR-0028 (the `CACHE` port's Redis reference
  driver), ADR-0029 (money as decimal string, never summed across currencies without an
  FX rate the platform does not have).
