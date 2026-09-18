import { moneyCompare } from '@openora/core/server';
import type { PromoOffer } from '../contract/index.js';

export type OfferEligibilityInput = {
  offer: Pick<
    PromoOffer,
    'status' | 'currency' | 'minDeposit' | 'rules' | 'validFrom' | 'validUntil'
  >;
  at: Date;
  countryCode?: string;
  isFirstDeposit?: boolean;
  deposit?: { amount: string; currency: string };
};

export type OfferIneligibility =
  | 'offer_inactive'
  | 'outside_validity_window'
  | 'country_excluded'
  | 'not_first_deposit'
  | 'currency_mismatch'
  | 'below_minimum_deposit';

/**
 * Whether an offer is open to this player, and if not, which rule closed it. Pure: the caller
 * supplies the facts, so the same predicate answers "show me the offers" and "credit this
 * deposit" without one of them drifting into a laxer version of the other.
 *
 * Absent facts fail the rule that needs them rather than passing it: an offer for first
 * depositors only is not open to a caller who cannot say whether this is a first deposit.
 */
export function offerIneligibility(input: OfferEligibilityInput): OfferIneligibility | null {
  const { offer, at } = input;

  if (offer.status !== 'active') {
    return 'offer_inactive';
  }
  if (
    (offer.validFrom !== null && at < new Date(offer.validFrom)) ||
    (offer.validUntil !== null && at > new Date(offer.validUntil))
  ) {
    return 'outside_validity_window';
  }
  if (
    input.countryCode !== undefined &&
    offer.rules.excludedCountries.includes(input.countryCode)
  ) {
    return 'country_excluded';
  }
  if (offer.rules.firstDepositOnly && input.isFirstDeposit !== true) {
    return 'not_first_deposit';
  }

  const { deposit } = input;
  if (deposit === undefined) {
    return null;
  }
  if (deposit.currency !== offer.currency) {
    return 'currency_mismatch';
  }
  if (moneyCompare(deposit.amount, offer.minDeposit) < 0) {
    return 'below_minimum_deposit';
  }
  return null;
}
