import { and, eq, sql } from 'drizzle-orm';
import { promoGrant, type PromoGrant } from '../schema/index.js';

/** A player's grant in `currency` that still funds play: active and not past its expiry. */
export const isLiveGrantIn = (userId: PromoGrant['userId'], currency: PromoGrant['currency']) =>
  and(
    eq(promoGrant.userId, userId),
    eq(promoGrant.currency, currency),
    eq(promoGrant.status, 'active'),
    sql`${promoGrant.expiresAt} > now()`,
  );
