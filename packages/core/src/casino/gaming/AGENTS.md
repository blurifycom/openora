# Gaming

Game catalog and play sessions. Owns `GAME_ADAPTER` (game list) and `RNG_ADAPTER` (random number generation) ports; default mocks. Tables: `game` (provider, category, `gameType`, metadata), `gameRound` (per-user session with bet/win amounts, currency, status).

Also binds `ADMIN_GAME_REPORTING` (`admin-reporting.ts`) - a read-only query port over `game`/`gameRound` for the back-office games-performance report. admin-console depends only on the port, never on this module's schema (ADR-0017/0025). `game.gameType` (`original`/`casino`/`sportsbook`) is declared on the core contract surface (`@openora/core/contracts` `schemas/game.ts`), not module-locally like `GAME_ROUND_STATUSES` - it has to be, since the isomorphic `ADMIN_GAME_REPORTING` port and admin-console's contract both need the same type and neither can import a domain module.

Routes serve both public reads (`listGames`, `getGame`) and player writes (`startRound`, `endRound`, `listRounds`). Each round tracks bet/win as decimals (to match wallet precision). Rounds stay tied to the initiating user via `userId` - no FK cross-module reference to wallet, just plain ID.

Round lifecycle: status moves `'active'` -> `'completed'` on end. A round without an `endedAt` is still in play; a finished round carries final bet/win for accounting.
