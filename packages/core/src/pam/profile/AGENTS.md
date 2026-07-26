# Profile

Player self-service read/write over the `player` table - the counterpart to player-management (operator CRUD) on the SAME schema. Access is player-only by userId match rather than a guard, and there is no admin override by design: profile edits are user-initiated only.
