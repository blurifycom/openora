# ADR-0036: Responsible-gambling money limits are enforced, and weakening one takes two steps

**Date**: 2026-08-27
**Status**: Accepted
**Amended by ADR-0037 (2026-08-30)**: the admin override (`RgService.setPlayerLimit`) is
now reduce-only - it may create a first limit or lower an existing one, but a raise is
refused server-side with a typed error. The paragraph below asserting the admin path
"still writes a limit outright in either direction" no longer holds; everything else in
this ADR (the enforcement points, the deposit/wager gates, the player-path cool-down,
and the concurrency reasoning) is unchanged.

## Context

ADR-0032 closed the exclusion dimension of responsible gambling: a cooling-off or
self-excluded player cannot log in, launch a round, or have a `bet` debited. The amount
dimension was still open.

A `user_limit` row (deposit / wager / loss, over a daily / weekly / monthly window) was
written, read back, and compared to the player's spend by `RgMonitoringService` for one
purpose only: raising an 80% `limit_threshold` flag on the back-office dashboard. Nothing
in the platform ever refused a deposit or a wager because of it. A player could set a
100/day deposit limit and deposit 10,000 the same afternoon, and the only consequence was
a review flag somebody might read later.

Two further gaps sat behind that:

- **The limit could be weakened instantly.** The player-facing `upsertLimit` was a bare
  upsert and `deleteLimit` a bare delete. A player who set a limit while in control could
  remove it seconds later, when they were not - which is precisely the moment the limit
  exists for. UKGC requires a wait before an increase takes effect, and a positive
  confirmation from the player afterwards; Anjouan (this platform's licence) mandates
  neither, but the protection is worthless without them.
- **`loss` was measured as gross stakes.** `spendFor` routed `loss` to the same
  `sum(betAmount)` query as `wager`. A player who staked 1000 and won 900 was recorded as
  having lost 1000. The flag had been lying about this since it was written; once the
  number started refusing wagers, it would have blocked players roughly an order of
  magnitude too early.

## Decision

**A second cross-domain port, `RG_LIMITS`**, alongside `PLAY_ELIGIBILITY` and bound the
same way - by the module that owns the data, consumed by modules that must not import it.
Compliance owns `user_limit` and the spend windows, so compliance binds it; wallet and
gaming resolve it and never see the compliance schema. The dependency stays one-way
(compliance already `dependsOn: ['wallet', 'gaming']`; the reverse import would cycle).

```ts
export type RgLimitsPort = {
  checkDeposit(userId: string, amount: string): Promise<RgLimitDecision>;
  checkWager(userId: string, amount: string): Promise<RgLimitDecision>;
};
```

The move being attempted is part of the comparison: the gate answers "may this happen",
not "has the limit already been passed". A refusal carries the whole reason as typed
`data` (`limitType`, `period`, `limit`, `used`), so a client renders a translated message
and never an error string.

**The port is optional for its consumers** (`c.has(RG_LIMITS)`), not `requiresPorts`. An
install without the compliance module has no `user_limit` table and nothing to enforce;
declaring it required would refuse to boot instead. Where it IS bound the gate is
fail-closed - a throwing `check*` refuses the move.

**Three enforcement points**, mirroring how ADR-0032 placed the exclusion dimension:

- `WalletService.deposit`, immediately after `assertDepositable` and **before the PSP
  call**. A refused deposit must never reach a provider.
- `GamingService.startRound`, beside the existing `playEligibility` check and before a
  launch token is issued. This is the route the _player_ calls, so it is the one that has
  to hand back something a client can translate; it owns its own `RgLimitExceededError`
  rather than reusing wallet's, because casino must not import wallet's internals.
- `WalletCommandsService.debit` for `type === 'bet'`, beside the existing
  `WalletRgRestrictedError`. This one is reached by inbound settlement and rarely becomes
  an HTTP response - it is the layer that holds when a round outlives the call that
  started it, exactly as in ADR-0032. `win` and `loss` stay ungated for the same reason.

A wager is measured against the **wager** limit only. The `loss` limit is deliberately
**not** enforced: net loss is stakes minus winnings, and this platform does not record
winnings - `game_round.winAmount` stays `'0'` on every row because win-crediting is
deferred to a sealed `GAME_OUTCOME_AUTHORITY` that does not exist yet (ADR-0034).
Enforcing against that number would refuse a wager the moment a player's _stakes_ reached
their loss limit, including for a player who is up on the window; refusing on a number we
know to be wrong is worse than not refusing. `spendFor` still computes net loss
correctly, so the 80% review flag becomes right the day payouts start being recorded, and
`TYPES_BY_MOVE` is the single line to change then.

**The deposit gate is check-then-act and does not serialize.** The stake debit does: its
check sits inside the debit transaction, after the `FOR UPDATE` on the player's wallet
row, so two concurrent bets queue and the second reads the first's committed round. The
deposit path cannot do the same - a PSP round-trip sits between the check and the credit,
holding a row lock across a vendor network call is not an option, and refusing after the
charge would strand the player's money. Two deposits started at once can therefore both
pass and together exceed the limit. Closing that needs a durable reservation taken before
the PSP call and released on failure, which changes the deposit ledger flow and is tracked
as its own change. Until then the excess is caught the way an on-chain deposit's is: the
`wallet.deposit.completed` evaluation raises the `limit_threshold` flag for compliance.

**Every refusal carries a `data.reason`** from a shared contract enum
(`RG_LIMIT_ERROR_REASONS`). Several of them share `CONFLICT` with an unrelated error on
the same route - `startRound` also returns it for an active exclusion, `deposit` for an
idempotency-key reuse, and the two limit-change refusals return it for opposite reasons -
so the status code alone cannot tell a client which sentence to show, and the message
string never reaches a screen.

`RG_FLAG_THRESHOLD_PCT` moves from the server-side evaluation into the contract layer:
the player-facing usage bar has to change colour at the same number the back-office flag
fires at, and two copies of `80` would drift.

**An on-chain crypto deposit is deliberately not gated.** It reaches the ledger through
`handlePaymentWebhook` when the funds are already on the chain. There is nothing left to
refuse: the money exists whether or not we accept it, and rejecting the credit would only
mean the player has lost it. That path raises the `limit_threshold` flag for compliance
instead, through the `wallet.deposit.completed` evaluation the credit already triggers.
The consequence is real and has to be said in the player-facing copy: **a deposit limit
stops fiat/PSP deposits and does not stop crypto ones.**

**Weakening a limit is a two-step change.** A raise or a removal parks a request in
`user_limit.pending*`; `amount` stays the limit in force. After
`responsibleGambling.limitIncreaseCooldownHours` (default 24, config not code - UK/MGA
24h, SE 72h, DE 7 days, Anjouan silent) the player may confirm, within
`limitChangeConfirmationWindowHours` (default 168). Setting a first limit and lowering an
existing one apply at once, and cancelling a request is always immediate: moving back
toward more protection is never slowed down.

The invariant, stated once and scoped precisely: **on the player's own path, nothing
raises a limit except their own confirm.** The expiry sweep only ever clears a lapsed
request, reads never promote one lazily, and `pendingChangeStatus` - the single reader of
those timestamps - reports a request past its window as expired whether or not the sweep
has run.

The invariant is about what a _player_ may do to their own protection. It is **not** a
restraint on the operator's compliance function: `RgService.setPlayerLimit`, the admin
route, still writes a limit outright in either direction and voids any parked request.
A compliance officer has to be able to impose a limit on the spot, and the override is
permissioned (`compliance:manage-rg`) and audited under the admin's own actor - which is
what makes it accountable rather than a hole. If a jurisdiction later requires the admin
path to serve the cool-down too, that is a change to this ADR first, not a quiet edit to
the service.

> **Superseded by ADR-0037.** "Impose a limit on the spot" was read here as licensing a
> raise; it never needed to. Imposing means creating a limit or lowering one - both still
> apply outright and immediately, exactly as above. Raising a limit the player set for
> themselves is not "imposing" one, it is the operator weakening the player's own
> protection, and the applicable RG policy permits an admin override only to reduce a
> limit. `setPlayerLimit` is reduce-only as of ADR-0037; a raise attempt is refused
> server-side with `LimitRaiseNotAllowedError`. The rest of this paragraph - create and
> lower apply outright, the permission and audit attribution, voiding a parked request -
> is unchanged.

Every read-then-decide path takes a per-limit advisory lock (`limitSlotKey`), because the
classification is only meaningful against the value that is still there when the write
lands: two concurrent lowerings of 100 to 50 and 80 both read 100, both classify as a
lowering, and the later one applies 80 over 50 as an un-cooled raise. Confirm, cancel and
expiry additionally pin their write to the exact request that was read
(`pendingRequestedAt`), so a confirm that raced a lowering applies nothing instead of
resurrecting a value the player has moved past, and two confirms cannot both emit.

## Consequences

- `upsertLimit` and `deleteLimit` change behaviour and output shape for downstream
  consumers: `deleteLimit` now files a request and returns the limit rather than
  `{ success: true }`, and both return a view carrying usage and pending state. Minor
  release; the changeset spells this out.
- The admin `getRgSection` returns the same view, so a compliance officer can see that a
  player has asked to raise a limit and that the cool-down is running. That was the
  information the section existed for and it was not there.
- `rg.limit.set` and the two activation events gain `initiatedBy`, and the audit mapper
  reads the actor from it instead of hard-coding `admin`. Player-initiated RG changes
  were previously filed against an admin actor - a false attribution in a regulated log.
- Four new topics (`rg.limit.change_requested` / `_confirmed` / `_cancelled` /
  `_expired`) keep "asked" and "did" separate, which is what lets a regulator see that
  the cool-down was actually served in between.
- **Known limitation, accepted deliberately.** `user_limit.amount` carries no currency and
  neither spend sum filters by one, so a player holding several balances has
  `0.001 BTC + 20 USDT` added up as `20.001`. Until now that only mis-set a review flag;
  it now makes a money decision, and it will bite unevenly - a player transacting in a
  high-value unit barely meets the limit, one in a low-value unit is blocked without
  cause. It stays because the correct fix (a currency on the limit, both sums filtered by
  it) needs a currency selector on the limit card and a product decision that has not been
  made, and because no rate source exists anywhere in the platform to convert with. The
  next step is recorded as a `TODO` at both read sites and tracked separately: add
  `user_limit.currency`, move the unique index to `(userId, type, period, currency)`, and
  filter both sums. Tests operate on a single currency so the wrong arithmetic is never
  frozen in as expected behaviour.
