import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import type { AdminGuard } from '@openora/core/server';
import type { KycStatusWriter } from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { user } from '@openora/core/pam/schema/identity';
import { migrate as migrateIdentity } from '@openora/core/pam/migrate/identity';
import { player } from '@openora/core/pam/schema/profile';
import { migrate as migrateProfile } from '@openora/core/pam/migrate/profile';
import { tag, playerTag } from '@openora/core/pam/schema/tag';
import { migrate as migrateTag } from '@openora/core/pam/migrate/tag';
import { mock, makeAdminGuard, testContext } from '../../../testing/mock.js';
import { createPlayerRouter } from '../router/index.js';
import { PlayerService } from '../service/player.service.js';

const CTX = testContext();
const CALLER = '44444444-4444-4444-8444-444444444444';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb([migrateIdentity, migrateProfile, migrateTag]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  await db.drizzle.db.execute(
    sql`TRUNCATE ${playerTag}, ${tag}, ${player}, ${user} RESTART IDENTITY CASCADE`,
  );
});

const guardAllowing = (allow: readonly string[]) =>
  makeAdminGuard({ allow, caller: { userId: CALLER } });

function build(adminGuard: AdminGuard) {
  const kycStatusWriter = mock<KycStatusWriter>({ setStatus: vi.fn() });
  const service = new PlayerService(db.drizzle, kycStatusWriter);
  return { router: createPlayerRouter(service, adminGuard), kycStatusWriter };
}

async function seedPlayer() {
  const [account] = await db.drizzle.db
    .insert(user)
    .values({ name: 'Player', email: `${randomUUID()}@example.com` })
    .returning();
  const [row] = await db.drizzle.db
    .insert(player)
    .values({ userId: account!.id, displayName: 'Player' })
    .returning();
  return row!;
}

async function storedPlayer(id: string) {
  const [row] = await db.drizzle.db.select().from(player).where(eq(player.id, id));
  return row;
}

describe('player router update KYC authz', () => {
  it('rejects a kycStatus change without compliance:override-limit and writes nothing', async () => {
    const seeded = await seedPlayer();
    const { router, kycStatusWriter } = build(guardAllowing(['player:update']));

    await expect(
      call(router.update, { playerId: seeded.id, kycStatus: 'verified' }, { context: CTX }),
    ).rejects.toBeInstanceOf(ORPCError);
    expect(kycStatusWriter.setStatus).not.toHaveBeenCalled();
    expect((await storedPlayer(seeded.id))?.kycStatus).toBe(seeded.kycStatus);
  });

  it('routes a gated kycStatus change through KYC_STATUS_WRITER', async () => {
    const seeded = await seedPlayer();
    const { router, kycStatusWriter } = build(
      guardAllowing(['player:update', 'compliance:override-limit']),
    );

    await call(router.update, { playerId: seeded.id, kycStatus: 'verified' }, { context: CTX });

    expect(kycStatusWriter.setStatus).toHaveBeenCalledWith(
      seeded.userId,
      'verified',
      { actorId: CALLER, source: 'manual' },
      expect.anything(),
    );
  });

  it('persists a non-KYC update with only player:update', async () => {
    const seeded = await seedPlayer();
    const { router } = build(guardAllowing(['player:update']));

    const result = await call(
      router.update,
      { playerId: seeded.id, displayName: 'New' },
      { context: CTX },
    );

    expect(result.displayName).toBe('New');
    expect((await storedPlayer(seeded.id))?.displayName).toBe('New');
  });

  it('maps an unknown player to NOT_FOUND', async () => {
    const { router } = build(guardAllowing(['player:update']));

    await expect(
      call(router.update, { playerId: randomUUID(), displayName: 'New' }, { context: CTX }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });
});
