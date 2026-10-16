import type { Race } from '../contract/index.js';
import { promoRace, type PromoRace } from '../schema/index.js';

export const RACE_COLUMNS = {
  id: promoRace.id,
  name: promoRace.name,
  currency: promoRace.currency,
  startAt: promoRace.startAt,
  endAt: promoRace.endAt,
  prizePool: promoRace.prizePool,
  positions: promoRace.positions,
  eligibleProducts: promoRace.eligibleProducts,
  closedAt: promoRace.closedAt,
  createdAt: promoRace.createdAt,
  updatedAt: promoRace.updatedAt,
};

export const toRace = (row: Pick<PromoRace, keyof typeof RACE_COLUMNS>): Race => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  startAt: row.startAt.toISOString(),
  endAt: row.endAt.toISOString(),
  prizePool: row.prizePool,
  positions: row.positions,
  eligibleProducts: row.eligibleProducts,
  closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
