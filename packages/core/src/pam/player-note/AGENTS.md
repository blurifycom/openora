# Player Note

Admin-only player annotations - an operator scratchpad, not a compliance record. Every write stamps `actorId` so notes carry authorship; no domain events, no cross-module coupling. Notes are permanent once written (no soft-delete).

## Don't

- Use this as the compliance/audit trail - that's the `audit` module.
