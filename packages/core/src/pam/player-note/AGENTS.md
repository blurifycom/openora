# Player Note

Admin-only player annotation. Table: `playerNote` (playerId, actorId, content, timestamps). Routes: CRUD (all admin-guarded).

Simple audit trail - no domain events, no cross-module coupling. ActorId stamps every write so notes carry authorship. Soft-delete not implemented (records are permanent once written).

Don't: use this for compliance audit (use the compliance audit module); this is operator scratchpad only.
