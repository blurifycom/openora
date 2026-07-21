# Player Management

Admin player CRUD, search, and analytics. Table: `player` (userId-keyed, status/KYC-status enums, level, lifetime wagered/deposits totals). Routes: `list` (searchable: name, email, user ID), `get`, `getByUserId`, `update` (with gated KYC-status change requiring `compliance:override-limit` permission), `remove` (bans player), `registrationsOverTime` (admin analytics), `summary`.

Owns `KYC_STATUS_WRITER` port (consumed by compliance for status transitions). Player status filtering via `status` input (active, suspended, banned). Trigram GIN index on display_name for fast ILIKE searches (requires pg_trgm).

KYC-status transition is compliance-regulated; bypassing `KYC_STATUS_WRITER` via direct player:update is blocked by an explicit check in the router (requires both `player:update` and `compliance:override-limit`).

`update()` emits `player.level.changed` (`{ userId, previousLevel, newLevel, actorId }`) after the transaction commits whenever `data.level` is provided and differs from the existing row's level - a best-effort fan-out event (unlike the `KYC_STATUS_WRITER` emit, which runs inside the transaction as a regulated single-writer seam, this one follows the standard post-commit idiom). The `tag` module subscribes to it to keep its single mutable `level` tag in sync.
