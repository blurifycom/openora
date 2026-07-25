# ADR-0032: Responsible-gambling enforcement at wager time

**Date**: 2026-07-25
**Status**: Accepted

## Context

Responsible-gambling exclusions (cooling-off, self-exclusion) were enforced at exactly
one point: login. `LOGIN_ENFORCEMENT.block` sets `user.rgBlocked`/`rgBlockedUntil` and
revokes every active session, and both login gates (password and phone OTP) refuse a
blocked player after their credentials verify. `compliance/AGENTS.md` stated the
enforcement depth explicitly: "block login + revoke all sessions. NO per-transaction
gating - the login block makes betting impossible transitively."

That transitive argument does not hold end to end:

- **A launched game outlives the session.** `startRound` hands the player a provider
  `launchUrl` + `token`. That token lives in the vendor's session, not ours. Revoking
  our sessions does not end a game already open in the player's browser.
- **Settlement is inbound, not player-driven.** An aggregator calls back to settle a
  round. `WALLET_COMMANDS.debit` is the seam it debits through, and it applied no
  eligibility check at all - it validated the amount and the balance, nothing else.
- **The block is asynchronous with play.** An admin activating a cooling-off while a
  player is mid-session had no way to stop the wager that was already in flight.

The regulatory requirement (BF-215) is that a cooling-off player "cannot log in or place
bets". Only the first half was true.

## Decision

Introduce a read port, `PLAY_ELIGIBILITY`
(`packages/core/src/contracts/adapters/play-eligibility.ts`):

```ts
export type PlayEligibilityPort = {
  isRestricted(userId: string): Promise<boolean>;
};
```

**Identity owns and binds it.** Identity owns the `user` table, and `rgBlocked` /
`rgBlockedUntil` is the projection `LOGIN_ENFORCEMENT` already maintains.
`PlayEligibilityService` reads that one indexed row and reuses the same `isRgBlocked`
predicate the login gate uses, so a wager and a login can never disagree about whether a
player is restricted - including the lazy-expiry behaviour, where an elapsed
`rgBlockedUntil` reads as unrestricted without waiting for the 60-second sweep.

**Two enforcement points, both fail-closed:**

- `GamingService.startRound` throws `RgRestrictedError` before touching the provider, so
  a restricted player never receives a launch token.
- `WalletCommandsService.debit` throws `WalletRgRestrictedError` when `type === 'bet'`.

An unknown user reads as restricted. A missing row means the caller cannot be resolved,
and refusing an unresolvable wager is the safe direction.

## Consequences

- Compliance is unchanged. It drives `LOGIN_ENFORCEMENT` exactly as before; the new port
  is a read of the projection that write already produces. No new state, no second source
  of truth, nothing to keep in sync.
- Gaming and wallet declare `requiresPorts: [PLAY_ELIGIBILITY]`. Neither imports the
  identity schema, so the extraction story of ADR-0017 is preserved: a remote identity
  service rebinds the port and the callers are untouched.
- `startRound` and a `bet` debit each cost one extra primary-key read. `win` and `loss`
  are deliberately NOT gated - they settle a round that was already staked, and refusing
  them would strand an in-flight round rather than protect the player.
- The gate is not a substitute for the login block. It is the second layer that makes the
  first one's guarantee actually hold at the money boundary.
