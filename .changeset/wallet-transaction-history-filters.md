---
'@openora/core': minor
---

`GET /wallet/transactions` (`wallet.listTransactions`) takes server-side filters: `types[]`, `statuses[]`, `currencies[]`, `from` / `to` (ISO datetimes, inclusive; `from` after `to` answers `400`) and `search` (a transaction id prefix, or an exact provider reference or tx hash). Filters, sort and paging now apply to the whole history in SQL, so `total` always matches what the filters select. `GET /wallet/transactions/{userId}` (`listPlayerTransactions`) takes the same filters.

The player's history now includes the bonus grants they received: a bonus, a chat gift, a rain drop or a VIP cashback grant appears as a row of type `bonus`, `gift`, `rain` or `cashback`, with the granted amount, direction `credit`, and status `pending`, `cancelled` or otherwise `completed`. The response shape is unchanged. The admin per-player list stays ledger-only.

New read port `BONUS_GRANT_LEDGER` (`BonusGrantLedgerReader`), bound by the bonus module: `ledgerRowsQuery(userId)` returns the SQL the wallet unions with its ledger. Without it bound, the history is the ledger alone.

**Behaviour change:** sorting by `type` or `status` now orders alphabetically rather than by enum declaration order.
