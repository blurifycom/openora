import { and, eq, sql } from 'drizzle-orm';
import { promoGrant, type PromoGrant } from '../schema/index.js';

/** A player's grant, in any currency, that still funds play: active and not past its expiry. */
export const isLiveGrantOf = (userId: PromoGrant['userId']) =>
  and(
    eq(promoGrant.userId, userId),
    eq(promoGrant.status, 'active'),
    sql`${promoGrant.expiresAt} > now()`,
  );

export const isLiveGrantIn = (userId: PromoGrant['userId'], currency: PromoGrant['currency']) =>
  and(isLiveGrantOf(userId), eq(promoGrant.currency, currency));
