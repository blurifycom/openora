# ADR-0037: The admin RG limit override is reduce-only

**Date**: 2026-08-30
**Status**: Accepted; implemented.
**Amends**: ADR-0036 (the "weakening a limit is a two-step change" section, specifically
the paragraph on the admin override).

## Context

ADR-0036 gave `RgService.setPlayerLimit` - the compliance-officer route,
`compliance:manage-rg`, `PUT /compliance/players/{userId}/limits` - the power to write a
player's responsible-gambling limit "outright in either direction", exempt from the
cool-down the player's own path serves. Its justification was that "a compliance officer
has to be able to impose a limit on the spot", and it explicitly reserved a raise
direction for a future jurisdiction requirement: "If a jurisdiction later requires the
admin path to serve the cool-down too, that is a change to this ADR first, not a quiet
edit to the service."

That justification conflated two different things. **Imposing** a limit on the spot
means creating one where none exists, or lowering one that is too high - both directions
a compliance officer plainly needs, and both still permitted here. It never meant
**raising** a limit the player set for themselves. Nothing about "impose it on the spot"
requires the operator to be able to move a player's own protection in the weaker
direction; the ADR's reasoning supports create-or-lower and does not extend to raise.

The applicable RG policy is direct about this: an admin override may reduce a
player-set limit, never increase it. Every override requires a documented reason and is
fully audited, which is what makes the reduced permission accountable rather than a
process gap. Allowing the reverse - the operator raising a limit the player imposed on
themselves - is the single most sensitive RG write there is: it is the platform's own
operator weakening a player's self-chosen protection, which is exactly the harm the
limit exists to prevent. Nothing about it is "on the spot" urgency; there is no
emergency that requires an operator to relax a player's own guardrail on their behalf.

## Decision

`RgService.setPlayerLimit` is now **reduce-only**:

- **Creating** a first limit (no existing row for that `userId`/`type`/`period`):
  allowed, unchanged, effective immediately.
- **Lowering** an existing limit: allowed, unchanged, effective immediately, and still
  voids any request the player has parked (`NO_PENDING_CHANGE`) - including a pending
  **raise**. A directly written, lower limit is the current decision; leaving a stale
  raise request parked beside it would let the player confirm their way back to a value
  the admin just moved past. This was already true generically before this ADR and did
  not need to change.
- **Raising** an existing limit: refused server-side with a typed `LimitRaiseNotAllowedError`
  (`packages/core/src/compliance/service/rg.service.ts`), mapped to `CONFLICT` at the
  router. Carries the prior and requested value as typed `data` so a client renders a
  precise sentence without a message string reaching the screen.
- **Removing** a limit entirely: the admin route was never able to express this - unlike
  the player's own `deleteLimit`, `SetPlayerLimitInputSchema` has no delete/null-out
  shape, only a value to set. There is therefore no existing removal behavior to
  reverse. Given the direction of this ADR, if a delete capability is ever added to this
  route it must be refused the same way a raise is: an admin deleting a player's limit
  removes the player's protection entirely, which is a stronger weakening than any raise
  and cannot be justified as an "impose on the spot" action either.

The classification (`isWeakening`) is the same function the player's own path
(`RgSelfServiceService.upsertLimit`) already used to decide whether to park a request,
now shared from `rg.service.ts` rather than duplicated: money-type limits compare
`amount`, the session-type limit compares `minutes` - the two are polymorphic by `type`
and a row can never carry both, so there is exactly one meaningful comparison per row.

**The reason and the confirm step are now mandatory on the input**
(`SetPlayerLimitInputSchema` gains `reason: z.string().trim().min(1)` and
`confirm: z.literal(true)`, matching `ActivateSelfExclusionInputSchema`), enforced by
the contract schema itself - not a UI affordance. `reason` flows into the `rg.limit.set`
domain event (`reason: z.string().nullable()`, version bumped to 4) so it lands in the
audit record the same way `before`/`after` already does, without a schema or table
change: the audit mapper already stores the full event payload as `after`. The field is
`nullable`, not newly mandatory on the event, because the same topic is also emitted by
the player's own `upsertLimit` path, which has no reason to give and must not be made to
invent one - the player path always passes `reason: null`.

**The raise check and the write share the same advisory lock and the same read** the
existing per-limit lock already took (`limitSlotKey`, per ADR-0036's concurrency
section). The classification is only meaningful against the value still present when
the write lands: two concurrent admin writes that each read the original value and each
independently conclude their own move is a lawful lowering can otherwise have the later
one land a value that is actually a raise over what the earlier one already committed.
Refusing the raise happens _inside_ the same transaction that reads the existing row and
performs the write, before either the insert or the `pending*` clear, so a refused raise
leaves the row and any parked player request completely untouched.

## Consequences

- `SetPlayerLimitInput` gains two required fields; this is a breaking change to the
  admin route's input shape. Downstream admin UIs must supply both.
- `rg.limit.set` version 4: `reason` added, nullable, null on the player path.
- A jurisdiction that legitimately needs an admin-raise path (none identified today)
  is a new ADR, not a reversion of this one - the licence-linked policy this ADR encodes
  is the reduce-only rule stated above, not a placeholder.
