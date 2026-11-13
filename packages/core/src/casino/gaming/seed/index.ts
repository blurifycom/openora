/**
 * Projects the catalogue into the round ledger's `ledger_game`. Run it after every migrate,
 * as the other reference seeders are: until it has run once, every round on a game imported
 * before the projection existed is refused with GamingUnknownGameError. Convergent and safe
 * to re-run; it also heals a projection that missed a `gaming.game.changed`.
 */
export { backfillLedgerGames } from '../service/ledger-game.service.js';
