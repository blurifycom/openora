# Player Management

Operator-facing player CRUD, search, and analytics over the `player` table (lifetime wagered/deposit totals live here). Search leans on a trigram GIN index on `display_name` for ILIKE - the DB needs `pg_trgm`.

## Invariants

- Owns and binds `KYC_STATUS_WRITER`; compliance drives KYC transitions through that port, never by writing `player`.
- A KYC-status change through the plain player update is rejected in the router unless the caller holds BOTH `player:update` and `compliance:override-limit` - the regulated transition can't be laundered through generic CRUD.
- `remove` bans the player; players are never hard-deleted.
