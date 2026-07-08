# Player Management

Admin player CRUD, search, and analytics. Table: `player` (userId-keyed, status/KYC-status enums, level, lifetime wagered/deposits totals). Routes: `list` (searchable: name, email, user ID), `get`, `getByUserId`, `update` (with gated KYC-status change requiring `compliance:override-limit` permission), `remove` (bans player), `registrationsOverTime` (admin analytics), `summary`.

Owns `KYC_STATUS_WRITER` port (consumed by compliance for status transitions). Player status filtering via `status` input (active, suspended, banned). Trigram GIN index on display_name for fast ILIKE searches (requires pg_trgm).

KYC-status transition is compliance-regulated; bypassing `KYC_STATUS_WRITER` via direct player:update is blocked by an explicit check in the router (requires both `player:update` and `compliance:override-limit`).
