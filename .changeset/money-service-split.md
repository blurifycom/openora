---
'@openora/core': minor
---

The money modules can now run in a service of their own, and the platform modules reach them through ports.

New `money-remote` plugin (`@openora/core/money-remote/plugin`). With `MONEY_SERVICE_URL` set (the money service's private origin; `MONEY_SERVICE_NAME` names it, default `money`) a process drops the money modules and every module that `dependsOn` one, and `money-remote` binds `WALLET_READER`, `EXCHANGE_RATE_READER`, `ADMIN_WALLET_REPORTING`, `ADMIN_GAME_REPORTING`, `MONEY_REPORTING`, `PLAYER_RANK_READER` and `LEDGER_API_V1` to a client of the money service over the signed internal API. Unset, it binds nothing. In production the URL must be https unless `MONEY_SERVICE_ALLOW_HTTP=true`. The money service answers only the `SERVICE_NAME`s in `MONEY_PORTS_CALLERS`; unset refuses every caller. A kept module that requires a port taking the caller's transaction fails the boot while `MONEY_SERVICE_URL` is set, and a manifest that names `money-remote` with the URL unset fails the boot.

Platform modules (analytics, compliance, player-management, support-chat, admin-console, tag, profile) now declare `requiresPorts` (`WALLET_READER`, `MONEY_REPORTING`, `PLAYER_RANK_READER`, `ADMIN_WALLET_REPORTING`, `ADMIN_GAME_REPORTING`, `EXCHANGE_RATE_READER`) in place of `dependsOn` the money modules. The money modules read player names, ids and claim eligibility through `IDENTITY_READER` in place of the identity tables.

The ledger projections write block-first and carry a freshness heartbeat. The owner schedules one recurring job every `LEDGER_PROJECTION_HEARTBEAT_MS` (default 10000), and a reader whose projection is written from another service refuses to answer once its last heartbeat is older than `LEDGER_PROJECTION_STALE_MS` (default 60000). A value that is not a positive whole number of milliseconds fails the boot.

New bin `openora-outbox-replay --since <ISO time> [--topic <topic>] [--dry-run]` republishes the outbox events written since a time, for a consumer that missed them. A time older than the outbox retention is refused.

`IdentityReader` gains the optional `getPlayerFacts(userIds)` and `getUserIdsByPlayerStatus(statuses)`. A custom `IdentityReader` binding should implement both: a money module that needs one throws when it is missing.

`BullMqJobQueue.close()` now lets every queue write and connection setup in flight settle before it closes, so a process closed right after boot no longer leaves unhandled "Connection is closed" rejections.

No migration.
