---
'@openora/core': minor
---

The money modules can now run in a service of their own, and the platform modules reach them through ports.

New `money-remote` plugin (`@openora/core/money-remote/plugin`). With `MONEY_SERVICE_URL` set (the money service's private origin; `MONEY_SERVICE_NAME` names it, default `money`) a process drops the money modules and every module that `dependsOn` one, and `money-remote` binds `WALLET_READER`, `EXCHANGE_RATE_READER`, `ADMIN_WALLET_REPORTING`, `ADMIN_GAME_REPORTING`, `MONEY_REPORTING`, `PLAYER_RANK_READER`, `PLAY_ELIGIBILITY_PROJECTION` and `RG_LIMIT_LEDGER` to a client of the money service over the signed internal API. Unset, it binds nothing. In production the URL must be https unless `MONEY_SERVICE_ALLOW_HTTP=true`. The money service answers only the `SERVICE_NAME`s in `MONEY_PORTS_CALLERS`; unset refuses every caller. A remote projection write keeps a newer version the ledger already holds, and `RgRateUnavailableError` and `LedgerProjectionStaleError` reach the caller as their own class. A money service with a separate database is not supported yet: both services share one. A kept module that requires a port taking the caller's transaction fails the boot while `MONEY_SERVICE_URL` is set, and a manifest that names `money-remote` with the URL unset fails the boot.

Platform modules (analytics, compliance, player-management, support-chat, admin-console, tag, profile) now declare `requiresPorts` (`WALLET_READER`, `MONEY_REPORTING`, `PLAYER_RANK_READER`, `ADMIN_WALLET_REPORTING`, `ADMIN_GAME_REPORTING`, `EXCHANGE_RATE_READER`) in place of `dependsOn` the money modules. The money modules read player names, ids and claim eligibility through `IDENTITY_READER` in place of the identity tables.

The ledger projections write block-first and carry a freshness heartbeat. The owner schedules one recurring job every `LEDGER_PROJECTION_HEARTBEAT_MS` (default 10000), and once `MONEY_PORTS_CALLERS` names a caller the ledger refuses a stake, deposit or wager when its last heartbeat is older than `LEDGER_PROJECTION_STALE_MS` (default 60000). A check logs an error once the last heartbeat is older than `LEDGER_PROJECTION_ALERT_MS` (default 30000). Set `MONEY_PORTS_CALLERS` only after the owners have beaten once (ADR-0062 rollout order). A value that is not a positive whole number of milliseconds fails the boot.

New bin `openora-outbox-replay --since <ISO time> [--topic <topic>] [--dry-run]` republishes the outbox events written since a time, for a consumer that missed them. A time older than the outbox retention is refused.

`IdentityReader` gains the optional `getPlayerIdsByUserIds`, `getLeaderboardNames`, `getUserContacts` and `getPlayerFacts` (each takes user ids). A custom `IdentityReader` binding must implement all four: a money module that needs one throws when it is missing.

`GameGeoCheckPort.listGeoRulePairs` takes `{ countries?, gameIds?, source? }` in place of a country list, and each game pair carries its `source`. `PlayerTags.getActiveTagKeys` takes an optional transaction to read on.

`BullMqJobQueue.close()` now lets every queue write and connection setup in flight settle before it closes, so a process closed right after boot no longer leaves unhandled "Connection is closed" rejections.

Migration: wallet `0052_ledger_projection_heartbeat` adds the `ledger_projection_heartbeat` table.
