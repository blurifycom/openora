import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inspect } from 'node:util';
import { eq } from 'drizzle-orm';
import { createClient } from 'redis';
import { JOB_QUEUE, SupportChatProviderError, queue } from '@openora/core/contracts';
import { DRIZZLE, loadExtensions, setErrorReporter } from '@openora/core/server';
import { SupportChatSyncFailedError } from '@openora/core/engagement/server';
import { user } from '@openora/core/pam/schema/identity';
import {
  bootE2e,
  closeE2e,
  registerAndMaterializePlayer,
  type TestApp,
  type TestDb,
} from '../index.js';
import {
  answerNextSupportChatTokenRaw,
  failNextSupportChatToken,
  failSupportChatSyncs,
  readSupportChatCalls,
  resetSupportChat,
  setSupportChatSyncHook,
} from '../test-support-chat-plugin.js';

const pluginPath = fileURLToPath(new URL('../test-support-chat-plugin.ts', import.meta.url));
const WAIT = { timeout: 15_000, interval: 50 };
const SESSION = '/support-chat/session';
const SYNC_QUEUE = 'support-chat.sync-customer';
const EMAIL = 'jane.doe@example.test';
const LEAK = /jane\.doe|sk_live_/;

let db: TestDb;
let testApp: TestApp;

beforeAll(async () => {
  const extensions = await loadExtensions();
  ({ db, app: testApp } = await bootE2e({
    plugins: [...extensions, { id: 'testing-support-chat', path: pluginPath }],
  }));
  resetSupportChat();
}, 60_000);

afterEach(() => {
  failSupportChatSyncs(false);
  setSupportChatSyncHook(null);
  setErrorReporter(undefined);
});

afterAll(async () => {
  await closeE2e({ app: testApp, db });
});

const dirt = () => `${EMAIL} sk_live_${randomUUID()}`;

const deepCause = (depth: number) => {
  let cause: unknown = new Error(dirt());
  for (let level = 0; level < depth; level++) {
    cause = Object.assign(new Error(dirt(), { cause }), { name: dirt() });
  }
  return cause;
};

const getterReason = () => {
  const err = new SupportChatProviderError('timeout');
  Object.defineProperty(err, 'reason', { get: dirt });
  return err;
};

const throwingReason = () => {
  const err = new SupportChatProviderError('timeout');
  Object.defineProperty(err, 'reason', {
    get: () => {
      throw new Error(dirt());
    },
  });
  return err;
};

const shapes: [string, () => Error][] = [
  [
    'a message and stack holding the secret',
    () => Object.assign(new Error(dirt()), { stack: `Error: ${dirt()}\n    at vendor` }),
  ],
  [
    'an unlisted reason and a name holding the secret',
    () =>
      Object.assign(Reflect.construct(SupportChatProviderError, [dirt()]) as Error, {
        name: dirt(),
      }),
  ],
  ['a reason that is a getter returning text', getterReason],
  ['a reason getter that throws the secret', throwingReason],
  [
    'a listed code over a six-level cause chain',
    () => new SupportChatProviderError('timeout', { cause: deepCause(6) }),
  ],
  ['a raw error over a six-level cause chain', () => new Error(dirt(), { cause: deepCause(6) })],
];

/** Every sync job hash BullMQ keeps, read from this app's own Redis database. */
async function storedJobs(): Promise<Record<string, string>[]> {
  const stored: Record<string, string>[] = [];
  const redis = createClient({ url: testApp.redisUrl });
  redis.on('error', () => undefined);
  await redis.connect();
  try {
    for await (const keys of redis.scanIterator({ MATCH: `bull:${SYNC_QUEUE}:*`, COUNT: 200 })) {
      for (const key of keys) {
        if ((await redis.type(key)) === 'hash') {
          stored.push(await redis.hGetAll(key));
        }
      }
    }
  } finally {
    redis.destroy();
  }
  return stored;
}

describe('support chat adapter failures that leak vendor text', () => {
  it.each(shapes)(
    'answers the player a generic 503 with nothing of %s in the response',
    async (_shape, thrown) => {
      const p = await registerAndMaterializePlayer(testApp, {
        email: `leak-${randomUUID()}@e2e.test`,
      });
      failNextSupportChatToken(thrown());
      const refused = await p.client.post(SESSION);
      const text = await refused.text();

      expect(refused.status).toBe(503);
      expect(JSON.parse(text)).toMatchObject({ message: 'Support chat is unavailable' });
      expect(text).not.toMatch(LEAK);
    },
  );

  it('answers the player a generic 503 when a token answer field throws on read', async () => {
    const reported: { error: unknown; context: unknown }[] = [];
    setErrorReporter((error, context) => reported.push({ error, context }));
    const p = await registerAndMaterializePlayer(testApp, {
      email: `leak-${randomUUID()}@e2e.test`,
    });
    answerNextSupportChatTokenRaw({
      customerId: `customer-${randomUUID()}`,
      tokenType: 'Bearer',
      expiresInMs: 60_000,
      get accessToken(): string {
        throw new Error(dirt());
      },
    });
    const refused = await p.client.post(SESSION);
    const text = await refused.text();

    expect(refused.status).toBe(503);
    expect(JSON.parse(text)).toMatchObject({ message: 'Support chat is unavailable' });
    expect(text).not.toMatch(LEAK);
    expect(inspect(reported, { depth: null, showHidden: true })).not.toMatch(LEAK);
  });

  it.each(shapes)(
    'keeps %s out of the error reporter and the stored job after a sync gives up',
    async (_shape, thrown) => {
      const reported: { error: unknown; context: unknown }[] = [];
      setErrorReporter((error, context) => reported.push({ error, context }));
      const p = await registerAndMaterializePlayer(testApp, {
        email: `leak-${randomUUID()}@e2e.test`,
      });
      expect((await p.client.post(SESSION)).status).toBe(200);
      failSupportChatSyncs(thrown());
      await testApp.container
        .get(JOB_QUEUE)
        .enqueue(queue(SYNC_QUEUE), { userId: p.userId }, { attempts: 1 });
      const deadLetter = await vi.waitFor(() => {
        const found = reported.find(({ context }) => inspect(context).includes(SYNC_QUEUE));
        if (!found) {
          throw new Error('sync dead-letter not reported yet');
        }
        return found;
      }, WAIT);

      expect(deadLetter.error).toBeInstanceOf(SupportChatSyncFailedError);
      expect((deadLetter.error as Error).cause).toBeUndefined();
      expect(inspect(reported, { depth: null, showHidden: true })).not.toMatch(LEAK);
      // BullMQ keeps `failedReason` and `stacktrace` of the failed job.
      const stored = await storedJobs();
      const own = stored.filter((job) => job.data?.includes(p.userId) && job.failedReason);
      expect(own.map((job) => job.failedReason)).toContainEqual(
        expect.stringMatching(/^support-chat provider failed: /),
      );
      expect(inspect(stored, { depth: null })).not.toMatch(LEAK);
    },
  );
});

describe('support chat sync failures that are not the adapter', () => {
  it('reports a context that never settles as itself, not as an adapter failure', async () => {
    const reported: { error: unknown; context: unknown }[] = [];
    setErrorReporter((error, context) => reported.push({ error, context }));
    const p = await registerAndMaterializePlayer(testApp, {
      email: `leak-${randomUUID()}@e2e.test`,
    });
    expect((await p.client.post(SESSION)).status).toBe(200);
    // The link's own sync lands first, so only the job below meets the moving name.
    await vi.waitFor(
      () =>
        expect(readSupportChatCalls().syncs.some((s) => s.context.userId === p.userId)).toBe(true),
      WAIT,
    );
    // Every write lands, then the player's name changes under it, so the re-read never settles.
    setSupportChatSyncHook(async () => {
      await testApp.container
        .get(DRIZZLE)
        .db.update(user)
        .set({ username: `moved-${randomUUID()}` })
        .where(eq(user.id, p.userId));
    });
    await testApp.container
      .get(JOB_QUEUE)
      .enqueue(queue(SYNC_QUEUE), { userId: p.userId }, { attempts: 1 });
    const deadLetter = await vi.waitFor(() => {
      const found = reported.find(({ context }) => inspect(context).includes(SYNC_QUEUE));
      if (!found) {
        throw new Error('sync dead-letter not reported yet');
      }
      return found;
    }, WAIT);

    expect(deadLetter.error).not.toBeInstanceOf(SupportChatSyncFailedError);
    expect((deadLetter.error as Error).name).toBe('SupportContextNotSettledError');
    expect((deadLetter.error as Error).message).toMatch(/still changing/);
  });
});
