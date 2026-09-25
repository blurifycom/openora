import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { makeAuditWriter } from '../../../testing/mock.js';
import { migrate } from '../migrate.js';
import { promoRace } from '../schema/index.js';
import {
  RaceAdminService,
  RaceClosedError,
  RaceNotFoundError,
  RacePositionsInvalidError,
} from '../service/race-admin.service.js';
import type { CreateRaceInput } from '../contract/index.js';

let db: TestDb;
const audit = makeAuditWriter();
let admin: RaceAdminService;
const adminId = randomUUID();

const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

const baseInput: CreateRaceInput = {
  name: 'Weekly Race',
  currency: 'USDT',
  startAt: hoursFromNow(-1),
  endAt: hoursFromNow(167),
  prizePool: '1000',
  positions: [
    { position: 1, prize: '500' },
    { position: 2, prize: '250' },
    { position: 3, prize: '100' },
  ],
  eligibleProducts: [],
};

beforeAll(async () => {
  db = await createTestDb([migrate]);
  admin = new RaceAdminService(db.drizzle, audit);
});

afterAll(() => db.drop());

beforeEach(async () => {
  audit.record.mockClear();
  audit.recordInTransaction.mockClear();
  await db.drizzle.db.delete(promoRace);
});

describe('creating a race', () => {
  it('creates a race and records an audit row', async () => {
    const race = await admin.create(adminId, baseInput);

    expect(race.name).toBe('Weekly Race');
    expect(race.closedAt).toBeNull();
    expect(audit.recordInTransaction).toHaveBeenCalledTimes(1);
    expect(audit.recordInTransaction.mock.calls[0]?.[1]).toMatchObject({
      action: 'promo.race.created',
      before: null,
    });
  });

  it('rejects positions whose prizes sum to more than the prize pool', async () => {
    await expect(
      admin.create(adminId, {
        ...baseInput,
        prizePool: '100',
        positions: [{ position: 1, prize: '500' }],
      }),
    ).rejects.toThrow(RacePositionsInvalidError);
  });
});

describe('updating a race', () => {
  it('replaces the config on an upcoming race and records a before/after audit row', async () => {
    const race = await admin.create(adminId, baseInput);

    const updated = await admin.update(adminId, {
      raceId: race.id,
      ...baseInput,
      prizePool: '2000',
      positions: [
        { position: 1, prize: '1000' },
        { position: 2, prize: '500' },
      ],
    });

    expect(updated.prizePool).toBe('2000.000000000000000000');
    expect(updated.positions).toHaveLength(2);
    expect(audit.recordInTransaction).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'promo.race.updated' }),
    );
  });

  it('rejects an update once the race has closed', async () => {
    const race = await admin.create(adminId, baseInput);
    // Close it directly - RaceAdminService itself never sets closedAt; that is the
    // settle job's job (RacePayoutService).
    await db.drizzle.db
      .update(promoRace)
      .set({ closedAt: new Date() })
      .where(eq(promoRace.id, race.id));

    await expect(admin.update(adminId, { raceId: race.id, ...baseInput })).rejects.toThrow(
      RaceClosedError,
    );
  });

  it('rejects an update to a race that does not exist', async () => {
    await expect(admin.update(adminId, { raceId: randomUUID(), ...baseInput })).rejects.toThrow(
      RaceNotFoundError,
    );
  });
});

describe('reading races', () => {
  it('lists and gets a race', async () => {
    const race = await admin.create(adminId, baseInput);

    await expect(admin.list()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: race.id })]),
    );
    await expect(admin.get(race.id)).resolves.toMatchObject({ id: race.id });
    await expect(admin.get(randomUUID())).rejects.toThrow(RaceNotFoundError);
  });
});
