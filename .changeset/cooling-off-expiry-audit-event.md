---
'@openora/core': patch
---

Cooling-off expiry left no audit trail: the `rg-monitor` sweep (and the equivalent in-transaction cleanup inside `activateCoolingOff`) silently flipped a lapsed cooling-off row to `expired`, with no event emitted for it.

- New `rg.cooling_off.expired` domain event, emitted by `RgService.expireLapsedCoolingOffs` (the sweep) and by `activateCoolingOff` when it clears a lapsed row before starting a fresh one.
- The audit plugin now subscribes to `rg.cooling_off.expired` and records it - `actorType: 'system'` (no admin acted), `resourceType: 'player'`, `before: { status: 'active' }`, matching the shape of the existing admin-initiated `rg.cooling_off.lifted` audit row.

Admin-initiated lifts (`rg.cooling_off.lifted`) were already audited - this closes the gap for the far more common case of a cooling-off simply running out the clock.
