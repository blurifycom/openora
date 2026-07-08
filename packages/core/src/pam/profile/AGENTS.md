# Profile

Player self-profile (non-admin read/write). Routes: `get` (player-only, own profile), `update` (player-only, self-service edits). Reads/writes `player` table (same schema as player-management) but rejects admin access (no guard, implicit player-only via userId match).

No admin override - profile updates are user-initiated only. Complementary to player-management (which is operator CRUD).
