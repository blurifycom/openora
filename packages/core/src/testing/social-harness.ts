import type { EventBus } from '../server/index.js';
import { migrate as migrateIdentity } from '../pam/identity/migrate.js';
import { migrate as migrateProfile } from '../pam/profile/migrate.js';
import { migrate as migrateChat } from '../engagement/chat/migrate.js';
import { migrate as migrateSocial } from '../engagement/social/migrate.js';
import { DrizzleAccountReader } from '../pam/identity/adapters/account-reader.service.js';
import { SocialService } from '../engagement/social/service/social.service.js';
import { createTestDb, type TestDb } from './real-infra.js';

export type SocialHarness = {
  testDb: TestDb;
  social: SocialService;
  emitted: { topic: string; payload: unknown }[];
};

export async function createSocialHarness(): Promise<SocialHarness> {
  const testDb = await createTestDb([migrateIdentity, migrateProfile, migrateChat, migrateSocial]);
  const emitted: SocialHarness['emitted'] = [];
  const events: EventBus = {
    emit() {},
    emitRaw() {},
    async emitInTransaction(_tx, topic, payload) {
      emitted.push({ topic, payload });
    },
    on: () => () => {},
    tapTransactional() {},
  };
  const social = new SocialService(
    testDb.drizzle,
    events,
    new DrizzleAccountReader(testDb.drizzle),
  );
  return { testDb, social, emitted };
}
