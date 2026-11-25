# ADR-0063: Money ports over the internal API

**Date**: 2026-11-25
**Status**: Accepted
**Relates to**: [ADR-0054](./0054-signed-internal-api-for-service-calls.md) (signed internal API), [ADR-0060](./0060-chat-ports-over-the-internal-api.md) (chat ports), [ADR-0062](./0062-ledger-projection-block-first-and-heartbeat.md) (projection heartbeat).

## Context

The backend splits into a `money` service (wallet, bonus, gamification, gaming rounds,
sportsbook, exchange rates) and a `platform` service. A bet stays one Postgres transaction, so every
module that writes in it moves with the ledger. Platform modules still read balances, rates, admin
reports, and write the two ledger projections (play eligibility, RG limits). Once the money tables
leave the platform's database, those reads and writes must cross the network.

The game catalogue no longer ties rounds to it: `game_round` has no foreign key to `game` and a
round reads the ledger-owned `ledger_game` projection, fed by `gaming.ledger_game.projected` with a
version guard (gaming migration `0021_ledger_game`, `docs/modules/gaming.md`). Nothing else in this
decision is needed for rounds.

## Decision

**`MONEY_SERVICE_URL` drops the money modules.** The chat drop is generalised into
`withoutRemoteModules`: each of `CHAT_SERVICE_URL` and `MONEY_SERVICE_URL` drops its root modules
and every plugin that `dependsOn` one. Chat behaves as before.

**One route, one table.** `MONEY_REMOTE_PORTS` in `@openora/core/contracts` lists each remote port,
its methods, how many arguments each sends, where a required `tx` sits, and which are writes. The
wallet plugin serves `POST /internal/v1/money/ports/call` to the services in `MONEY_PORTS_CALLERS`,
answering from the money service's own binding; `money-remote` binds a client of it. Values cross as
JSON that keeps `Date`, `Map` and omitted arguments. A per-method route with its own schema was
rejected for now: about forty methods, all already typed at the port, and the method table is
checked against each port type at compile time.

**Fail closed, retry writes once.** 2s timeout, no cache. A read failure throws a 503. A write
carries an idempotency key and is retried once with the same signed body on a timeout, network
failure or 5xx. The money side needs no key store, because every remote write is idempotent at its
owner: ledger ops are keyed by provider reference, projection writes keep the highest version,
heartbeats are a timestamp.

**Transactional ports stay local.** `MONEY_TX_BOUND_PORTS` (wallet commands, wager tracking, the
bonus ports, gaming commands, RG limit and play gates) join the caller's transaction and are never
remote. A kept module requiring one fails the boot when `MONEY_SERVICE_URL` is set.

**Projection writers are remote.** `PLAY_ELIGIBILITY_PROJECTION` and `RG_LIMIT_LEDGER` are bound
with `remote: true`, so ADR-0062's block-first, lift-by-event and stale-heartbeat rules apply.

## Consequences

- A platform module that keeps `dependsOn` a money module is dropped with it; it must require ports
  instead, as the chat split did.
- The ledger answers on its own transaction: a projection write is no longer atomic with the
  writer's change, which ADR-0062 covers.
- The sportsbook ledger ops on `LEDGER_API_V1` are not remote; they throw on a platform binding.
- The game catalogue (`gaming`) is a money module, so a platform with `MONEY_SERVICE_URL` set serves
  no catalogue routes until the catalogue is split from rounds into a module of its own.
