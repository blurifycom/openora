import { moneyCompare } from '@openora/core/server';
import type { PromoOffer } from '../contract/index.js';

export type OfferEligibilityInput = {
  offer: Pick<
    PromoOffer,
    'status' | 'currency' | 'minDeposit' | 'rules' | 'validFrom' | 'validUntil'
  >;
  at: Date;
  isFirstDeposit?: boolean;
  deposit?: { amount: string; currency: string };
};

export type OfferIneligibility =
  | 'offer_inactive'
  | 'outside_validity_window'
  | 'not_first_deposit'
  | 'currency_mismatch'
  | 'below_minimum_deposit';

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
