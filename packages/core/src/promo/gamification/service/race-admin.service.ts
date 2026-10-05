import { desc, eq } from 'drizzle-orm';
import type { AuditWritePort, Uuid } from '@openora/core/contracts';
import {
  createDomainError,
  makeConflictError,
  moneyAdd,
  moneyCompare,
  type DrizzleService,
} from '@openora/core/server';
import type { CreateRaceInput, Race, UpdateRaceInput } from '../contract/index.js';
import { promoRace } from '../schema/index.js';
import { RaceNotFoundError } from './race.service.js';

export { RaceNotFoundError };

export const RacePositionsInvalidError = createDomainError<[reason: string]>(
  'RacePositionsInvalidError',
  (reason) => `the race's positions would be invalid: ${reason}`,
);

export const RaceClosedError = makeConflictError(
  'RaceClosedError',
  'a closed race cannot be edited - standings are already frozen',
);

const RACE_COLUMNS = {
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

const toRace = (row: {
  id: string;
  name: string;
  currency: string;
  startAt: Date;
  endAt: Date;
  prizePool: string;
  positions: Race['positions'];
  eligibleProducts: string[];
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): Race => ({
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

function assertPositionsAffordable(prizePool: string, positions: readonly { prize: string }[]) {
  const sum = positions.reduce((total, entry) => moneyAdd(total, entry.prize), '0');
  if (moneyCompare(sum, prizePool) > 0) {
    throw new RacePositionsInvalidError('the prizes sum to more than the prize pool');
  }
}

/**
 * The operator's side of a race: create, list, and read one, and replace its config as one
 * validated set - the same shape `RankAdminService.set`/`setConfig` use. Every write is audited
 * with a before/after.
 *
 * Prospective only: editing dates, the prize pool, positions or eligible products on a race that
 * has already closed is refused outright, the same conservative rule `RankAdminService` applies
 * once players hold ladder state. An active/upcoming race may still be edited - its leaderboard
 * and payout are computed from live data at settle time, so a mid-race edit only ever affects
 * standings going forward.
 */
export class RaceAdminService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async list(): Promise<Race[]> {
    const rows = await this.drizzle.db
      .select(RACE_COLUMNS)
      .from(promoRace)
      .orderBy(desc(promoRace.startAt));
    return rows.map(toRace);
  }

  async get(raceId: Uuid): Promise<Race> {
    const [row] = await this.drizzle.db
      .select(RACE_COLUMNS)
      .from(promoRace)
      .where(eq(promoRace.id, raceId));
    if (!row) {
      throw new RaceNotFoundError(raceId);
    }
    return toRace(row);
  }

  async create(adminId: Uuid, input: CreateRaceInput): Promise<Race> {
    assertPositionsAffordable(input.prizePool, input.positions);
    return this.drizzle.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(promoRace)
        .values({
          ...input,
          startAt: new Date(input.startAt),
          endAt: new Date(input.endAt),
          createdBy: adminId,
          updatedBy: adminId,
        })
        .returning(RACE_COLUMNS);
      if (!created) {
        throw new Error('race insert returned no row');
      }
      const race = toRace(created);
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.race.created',
        resourceType: 'promo_race',
        resourceId: race.id,
        before: null,
        after: race,
      });
      return race;
    });
  }

  async update(adminId: Uuid, input: UpdateRaceInput): Promise<Race> {
    const { raceId, ...fields } = input;
    assertPositionsAffordable(fields.prizePool, fields.positions);
    return this.drizzle.db.transaction(async (tx) => {
      const [locked] = await tx
        .select(RACE_COLUMNS)
        .from(promoRace)
        .where(eq(promoRace.id, raceId))
        .for('update');
      if (!locked) {
        throw new RaceNotFoundError(raceId);
      }
      if (locked.closedAt !== null) {
        throw new RaceClosedError();
      }
      const before = toRace(locked);
      const [updated] = await tx
        .update(promoRace)
        .set({
          ...fields,
          startAt: new Date(fields.startAt),
          endAt: new Date(fields.endAt),
          updatedBy: adminId,
        })
        .where(eq(promoRace.id, raceId))
        .returning(RACE_COLUMNS);
      if (!updated) {
        throw new Error('race update returned no row');
      }
      const after = toRace(updated);
      await this.audit.recordInTransaction(tx, {
        actorId: adminId,
        actorType: 'admin',
        action: 'promo.race.updated',
        resourceType: 'promo_race',
        resourceId: raceId,
        before,
        after,
      });
      return after;
    });
  }
}
