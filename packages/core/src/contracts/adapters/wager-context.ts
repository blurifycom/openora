/**
 * What a single bet was placed on. Threaded from the game provider seam through the wallet
 * debit into the bonus engine, which resolves a wagering weight from it (game, then category,
 * then product, then the profile default), and on into gamification, which counts qualifying
 * wagers.
 *
 * `gameId` and `categorySlug` are optional by design: an aggregator that has not synced its
 * catalogue yet can only name the product, and the product dimension is what a "casino only,
 * PvP and sportsbook excluded" rule needs. `providerGameKey` keeps the raw vendor identifier
 * so the finer rows can be backfilled once the catalogue lands.
 */
export type WagerContext = {
  /** Adapter that reported the bet, e.g. the aggregator's plugin id. */
  provider: string;
  /** Raw vendor game identifier, unresolved. Persisted so a backfill is possible. */
  providerGameKey?: string;
  /** Vendor product bucket, e.g. 'casino', 'live-casino', 'sportsbook', 'pvp'. */
  product?: string;
  /** Platform game id, once the catalogue can resolve `providerGameKey`. */
  gameId?: string;
  /** Lobby category, once the catalogue can resolve `providerGameKey`. */
  categorySlug?: string;
};
