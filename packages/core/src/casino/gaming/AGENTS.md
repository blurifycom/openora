# Gaming

Game catalog and play sessions. Owns `GAME_ADAPTER` (game list) and `RNG_ADAPTER` (random number generation) ports; default mocks. Tables: `game` (provider, category, metadata), `gameRound` (per-user session with bet/win amounts, currency, status).

Routes serve both public reads (`listGames`, `getGame`) and player writes (`startRound`, `endRound`, `listRounds`). Each round tracks bet/win as decimals (to match wallet precision). Rounds stay tied to the initiating user via `userId` - no FK cross-module reference to wallet, just plain ID.

Round lifecycle: status moves `'active'` -> `'completed'` on end. A round without an `endedAt` is still in play; a finished round carries final bet/win for accounting.
