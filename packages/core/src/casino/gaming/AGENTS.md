# Gaming

Game catalog and play sessions. Owns the `GAME_ADAPTER` (catalog) and `RNG_ADAPTER` (randomness) ports - this repo ships mocks only; a real aggregator rebinds them in an overlay.

## Invariants

- A round moves `active` -> `completed` once. No `endedAt` means still in play; a completed round's bet/win are final for accounting.
- Bet/win are decimals matching wallet precision - never floats.
- `gameRound.userId` is a plain uuid, no FK into another module's tables (cross-module FKs are unenforceable once tables split).
