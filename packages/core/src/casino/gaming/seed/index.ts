/**
 * Projects the catalogue into the round ledger's `ledger_game`. The gaming module already runs
 * it at every boot; call it after a seed or import that wrote `game` rows without reporting them
 * through GAMING_COMMANDS. Convergent and safe to re-run; it also heals a projection that missed
 * a `gaming.ledger_game.projected`.
 */
export { backfillLedgerGames } from '../service/ledger-game.service.js';
