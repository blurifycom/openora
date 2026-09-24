/**
 * The product buckets a wager can name. Closed on purpose: an adapter maps its vendor's own
 * bucket onto one of these, so a new or misspelled vendor value cannot slip past the product
 * weights onto the profile default.
 */
export const WAGER_PRODUCTS = ['casino', 'live-casino', 'sportsbook', 'pvp'] as const;
export type WagerProduct = (typeof WAGER_PRODUCTS)[number];

export const isWagerProduct = (value: string): value is WagerProduct =>
  (WAGER_PRODUCTS as readonly string[]).includes(value);

/**
 * What a single bet was placed on. Threaded from the game provider seam through the wallet
 * debit into the bonus engine, which resolves a wagering weight from it (game, then category,
 * then product, then the profile default), and on into gamification, which counts qualifying
 * wagers.
 *
 * `product` is required: a wager that cannot name its product would otherwise fall through to
 * the profile default and advance rollover for a sportsbook or PvP bet. `gameId` and
 * `categorySlug` are optional by design: an aggregator that has not synced its catalogue yet can
 * only name the product, and the product dimension is what a "casino only, PvP and sportsbook
 * excluded" rule needs. `providerGameKey` keeps the raw vendor identifier
 * so the finer rows can be backfilled once the catalogue lands.
 */
export type WagerContext = {
  /** Adapter that reported the bet, e.g. the aggregator's plugin id. */
  provider: string;
  /** Raw vendor game identifier, unresolved. Persisted so a backfill is possible. */
  providerGameKey?: string;
  /** Product bucket, mapped by the adapter from the vendor's own. */
  product: WagerProduct;
  /** Platform game id, once the catalogue can resolve `providerGameKey`. */
  gameId?: string;
  /** Lobby category, once the catalogue can resolve `providerGameKey`. */
  categorySlug?: string;
};
