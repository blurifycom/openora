# ADR-0034: Wire the Stake Debit Into Gameplay, Defer Win-Crediting to a Certified Outcome Authority

**Date**: 2026-07-26
**Status**: Accepted

## Context

`casino/gaming`'s `startRound`/`endRound` have never moved money: `game_round.betAmount`
and `winAmount` are declared `decimal` columns that stay `'0'` for every row, because
the service never calls `WALLET_COMMANDS`. This was surfaced while building BF-219
(financial analytics) - GGR had to be sourced from `wallet_transaction` instead of
`game_round` as a result, and per-game GGR (BF-218) has no real data to report on at
all.

Closing this fully means answering two independent questions:

1. **Taking the stake** - a plain wallet debit when a round starts. No different in
   kind from any other `WALLET_COMMANDS.debit` call; not a regulated decision.
2. **Crediting a win** - deciding _how much_ a round paid out. This is not incidental
   plumbing: `packages/core/src/compliance/sealed.ts` already declares
   `GAME_OUTCOME_AUTHORITY`, a `SealedToken` documented as "Game round outcome / RNG /
   RTP - RGS / lab-certified (GLI, eCOGRA, BMM, iTechLabs). Operators cannot alter
   outcomes, payouts, or RTP from the backoffice." It is listed as a documented
   regulatory placeholder with **no** implementation anywhere in the platform (absent
   from `IMPLEMENTED_SEALED_TOKENS`, which today holds only `AUDIT_WRITER`). The
   existing `RNG_ADAPTER`/`MockRngAdapter` seam carries the same warning in its own
   doc comment: "NOT for real-money game outcomes."

The available game-integration seam, `GameAdapter`, has no outcome-bearing return
value today (`endRound(externalRoundId): Promise<void>`) and `startRound` takes no
stake amount at all.

## Decision

Wire only the stake side now. `StartRoundInputSchema` gains a required, positive
`betAmount`; `GamingService.startRound` debits it via `WALLET_COMMANDS.debit(tx, {
type: 'bet' })` in the same transaction as the `game_round` insert (atomic - a
shortfall throws `InsufficientBalanceError` and no round is created), before calling
`GameAdapter.launchGame` so an unaffordable stake never reaches an external provider.
`betAmount` is real and persisted from here on; GGR computed from `wallet_transaction`
now reflects genuine gameplay instead of only demo-seed/test fixtures.

`endRound` is left untouched. We explicitly do **not** extend `GameAdapter`/
`MockGameAdapter`/`RNG_ADAPTER` to fabricate a win amount to credit. Rejected
alternatives:

- **Mock a win amount through `GameAdapter`, documented as non-authoritative** -
  rejected because "working-looking" code is exactly what an OSS consumer is likely
  to copy into a real deployment regardless of how loudly it's commented; a sealed
  token exists specifically so that outcome/RTP logic cannot live in an
  operator-editable path, and a heavily-caveated mock still lives in that path.
- **Design `GameOutcomeAuthority`'s concrete shape now and bind a mock via
  `ctx.provideSealed()`** - the architecturally "correct" long-term answer (it is
  exactly what the sealed-token seam is for), but designing the concrete contract for
  a regulator-cited, lab-certification-gated port is a decision for an actual
  compliance/RGS design partner, not something to freehand ahead of one existing.

Win-crediting stays deferred until a real (or a properly-scoped mock, designed with
that partner) `GameOutcomeAuthority` implementation exists to bind via
`ctx.provideSealed(GAME_OUTCOME_AUTHORITY, ...)`. `game_round.winAmount` and
per-`game_round` GGR (BF-218) remain blocked on that, not on anything in this change.

## Consequences

**Positive:**

- Real money now moves for gameplay (previously it never did at all) - `wallet_transaction`
  `type='bet'` rows are genuine ledger entries, not just analytics/demo fixtures.
- The insufficient-balance path is checked before the external `GameAdapter.launchGame`
  call, so a player who can't afford the stake never triggers a wasted provider round-trip.
- No fabricated outcome/RTP logic is introduced anywhere the sealed-token architecture
  says it must not live.

**Negative / trade-offs:**

- `winAmount` and per-game GGR remain unavailable until a certified outcome authority
  is designed and bound - this ADR does not close that gap, only stops it from being
  closed the wrong way.
- `gaming` now `dependsOn: ['wallet']` - a new inter-module dependency (previously
  none), though `WALLET_COMMANDS` is exactly the sanctioned command-port seam for this
  (ADR-0017).
- A round whose `GameAdapter.launchGame` call fails after the stake is already debited
  and the round row committed has no compensation/refund path here - an accepted gap
  for a mock provider that never fails; a real provider integration would need one.

**Neutral:**

- Relates to ADR-0017 (command ports), ADR-0025 (sealed-token list,
  `assertSealedServicesBound`), ADR-0033 (analytics sources GGR from
  `wallet_transaction`, updated here to note `betAmount` is now real).
