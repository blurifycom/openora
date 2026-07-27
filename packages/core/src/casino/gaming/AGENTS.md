# Gaming

Game catalog and play sessions. Owns `GAME_ADAPTER` (game list) and `RNG_ADAPTER` (random number generation) ports; default mocks. Depends on `wallet` for `WALLET_COMMANDS`. Tables: `game` (provider, category, metadata), `gameRound` (per-user session with bet/win amounts, currency, status).

## Invariants

Round lifecycle: status moves `'active'` -> `'completed'` on end. A round without an `endedAt` is still in play.

Bet/win are decimals matching wallet precision - never floats. `gameRound.userId` is a plain uuid, no FK into another module's tables.

`startRound` debits the stake via `WALLET_COMMANDS.debit` and inserts the `game_round` row in the same transaction (atomic - a failed debit throws `InsufficientBalanceError` and no round is created), before calling `GameAdapter.launchGame` so an unaffordable stake never reaches the external provider. `betAmount` is real and persisted from here on.

`endRound` does NOT credit a win - `winAmount` stays `'0'` for every round. Determining how much a round paid out is game-outcome/RTP territory, gated by the sealed, regulator-mandated `GAME_OUTCOME_AUTHORITY` token (`@openora/core/compliance`, GLI/eCOGRA/BMM/iTechLabs - "operators cannot alter outcomes, payouts, or RTP from the backoffice"), which has no implementation anywhere in the platform yet. Do not fake a win amount through `GameAdapter`/`RNG_ADAPTER` to close this gap - that is exactly the anti-pattern the sealed token exists to prevent. Wiring a real win-credit path needs a concrete `GameOutcomeAuthority` port bound via `ctx.provideSealed()` by a certified RGS integration, which is out of scope until that partner exists.
