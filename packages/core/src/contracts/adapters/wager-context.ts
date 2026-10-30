import * as z from 'zod';

/**
 * The product buckets a wager can name. Closed on purpose: an adapter maps its vendor's own
 * bucket onto one of these, so a new or misspelled vendor value cannot slip past the product
 * weights onto the profile default.
 */
export const WAGER_PRODUCTS = ['casino', 'live-casino', 'sportsbook', 'pvp'] as const;
export const WagerProductSchema = z.enum(WAGER_PRODUCTS);
export type WagerProduct = z.infer<typeof WagerProductSchema>;

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
  /**
   * Return to player of the game variant actually played, as a decimal fraction (`'0.96'`).
   * Recorded on the bet's ledger row when `isWagerRtp` holds; `houseEdge` prices it.
   */
  rtp?: string;
};

// A percent value (`'96'`) fails it rather than being guessed at.
const RTP_PATTERN = /^(0(\.\d{1,18})?|1(\.0{1,18})?)$/;

/** A decimal fraction in [0, 1] with at most 18 places, the shape `WagerContext.rtp` takes. */
export const isWagerRtp = (rtp: string) => RTP_PATTERN.test(rtp);

/** A zero rtp is a game that never pays back, which in practice is a missing value. */
export const isUsableRtp = (rtp?: string | null): rtp is string =>
  rtp !== undefined && rtp !== null && isWagerRtp(rtp) && /[1-9]/.test(rtp);
