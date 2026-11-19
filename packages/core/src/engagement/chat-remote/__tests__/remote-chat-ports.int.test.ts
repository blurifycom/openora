import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { sql } from 'drizzle-orm';
import { call, ORPCError } from '@orpc/server';
import {
  Container,
  createInternalClient,
  DRIZZLE,
  EVENT_BUS,
  InternalApiError,
  ModuleRegistryImpl,
  type CoreTokenCatalog,
  type InternalClient,
} from '@openora/core/server';
import {
  ACCOUNT_READER,
  ADMIN_USER_DIRECTORY,
  AUDIT_WRITER,
  CHAT_BLOCK_READER,
  CHAT_BLOCK_READER_ROUTES,
  CHAT_TRANSFER_CHECK,
  CHAT_TRANSFER_CHECK_ROUTES,
  checkChatTransfer,
  ChatBlockReaderWire,
  ChatTransferCheckWire,
  IDENTITY_READER,
  REALTIME_TRANSPORT,
  type AccountReader,
  type AdminUserDirectory,
  type ChatTransferCheckInput,
} from '@openora/core/contracts';
import { createTestDb, type TestDb } from '@openora/core/testing';
import { migrate as migrateChat } from '@openora/core/engagement/migrate/chat';
import { chatUserBlock } from '@openora/core/engagement/schema/chat';
import chatPlugin from '@openora/core/engagement/plugins/chat';
import {
  makeAuditWriter,
  makeEventBus,
  makeIdentityReader,
  makeRealtimeTransport,
  mock,
  NO_CLIENT_META,
} from '../../../testing/mock.js';
import { migrate } from '@openora/core/engagement/migrate/chat-commands';
import { chatCommandConfig } from '@openora/core/engagement/schema/chat-commands';
import chatCommandsPlugin from '@openora/core/engagement/plugins/chat-commands';
import chatRemotePlugin from '../plugin.js';
import { RemoteChatBlockReader } from '../service/remote-chat-block-reader.service.js';
import { RemoteChatTransferCheck } from '../service/remote-chat-transfer-check.service.js';

const MONEY = 'money';
const ENV_KEYS = [
  'CHAT_BLOCK_READER_CALLERS',
  'CHAT_TRANSFER_CHECK_CALLERS',
  'CHAT_SERVICE_URL',
  'INTERNAL_API_SECRETS',
  'NODE_ENV',
  'CHAT_SERVICE_ALLOW_HTTP',
  'SERVICE_MANIFEST',
] as const;
const savedEnv = ENV_KEYS.map((key) => [key, process.env[key]] as const);

type Procedure = Parameters<typeof call>[0];
type BlocksRouter = Record<'excluded' | 'blocked' | 'blockers', Procedure>;
type TransferRouter = { check: Procedure };

let db: TestDb;

const contextFor = (internalCaller: string) => ({
  request: { headers: {} as Record<string, string | string[] | undefined> },
  clientMeta: NO_CLIENT_META,
  internalCaller,
});

function newContainer() {
  const container = new Container<CoreTokenCatalog>();
  container.register(DRIZZLE, () => db.drizzle);
  container.register(EVENT_BUS, () => makeEventBus());
  container.register(AUDIT_WRITER, () => makeAuditWriter());
  container.register(REALTIME_TRANSPORT, () => makeRealtimeTransport());
  container.register(ACCOUNT_READER, () => mock<AccountReader>({}));
  container.register(IDENTITY_READER, () => makeIdentityReader());
  container.register(ADMIN_USER_DIRECTORY, () =>
    mock<AdminUserDirectory>({ lookupPlayers: async () => [] }),
  );
  return { container, registry: new ModuleRegistryImpl<CoreTokenCatalog>(container) };
}

/**
 * The chat service: chat and chat-commands registered for real, their internal routes served in
 * process as `caller`, replies sent through JSON. `callers` is the allow-list env both routes read.
 */
function chatService(caller: string, callers = MONEY) {
  process.env['CHAT_BLOCK_READER_CALLERS'] = callers;
  process.env['CHAT_TRANSFER_CHECK_CALLERS'] = callers;
  const { container, registry } = newContainer();
  chatPlugin.register(registry);
  chatCommandsPlugin.register(registry);
  const internal = registry.routers.getInternal();
  const blocks = internal.get('chat')?.(container) as BlocksRouter;
  const transfer = internal.get('chat-commands')?.(container) as TransferRouter;
  const context = contextFor(caller);
  const blockRoutes = {
    [CHAT_BLOCK_READER_ROUTES.excluded]: blocks.excluded,
    [CHAT_BLOCK_READER_ROUTES.blocked]: blocks.blocked,
    [CHAT_BLOCK_READER_ROUTES.blockers]: blocks.blockers,
  } as const;
  const client: InternalClient = {
    async request(_method, path, body) {
      const reply =
        path === CHAT_TRANSFER_CHECK_ROUTES.check
          ? await call(transfer.check, ChatTransferCheckWire.check.input.parse(body), { context })
          : await call(
              blockRoutes[path as keyof typeof blockRoutes],
              ChatBlockReaderWire.excluded.input.parse(body),
              { context },
            );
      return JSON.parse(JSON.stringify(reply));
    },
  };
  return {
    client,
    local: {
      reader: container.get(CHAT_BLOCK_READER),
      check: container.get(CHAT_TRANSFER_CHECK),
    },
  };
}

/** A real signed client whose network is `fetch`, timing out after 20ms. */
function overNetwork(fetch: (url: URL, init: RequestInit) => Promise<Response>) {
  vi.stubGlobal('fetch', fetch);
  return createInternalClient({
    baseUrl: 'http://chat.test',
    serviceName: MONEY,
    audience: 'chat',
    secrets: 'x'.repeat(32),
    timeoutMs: 20,
  });
}

const stalled = (_url: URL, init: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
  });

const gift = (over: Partial<ChatTransferCheckInput> = {}): ChatTransferCheckInput => ({
  actorId: randomUUID(),
  roomId: null,
  counterpartIds: [],
  command: 'gift',
  ...over,
});

const settle = (promise: Promise<unknown>) => promise.catch((err: unknown) => err);

beforeAll(async () => {
  db = await createTestDb([migrateChat, migrate]);
});

afterAll(async () => {
  await db.drop();
});

beforeEach(async () => {
  delete process.env['CHAT_SERVICE_URL'];
  process.env['INTERNAL_API_SECRETS'] = 'x'.repeat(32);
  await db.drizzle.db.execute(sql`TRUNCATE ${chatUserBlock}, ${chatCommandConfig} CASCADE`);
  await db.drizzle.db.insert(chatCommandConfig).values({ key: 'gift', label: 'gift' });
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('RemoteChatBlockReader against the chat internal routes', () => {
  it('answers every read as the local reader does', async () => {
    const { client, local } = chatService(MONEY);
    const remote = new RemoteChatBlockReader(client);
    const [viewer, blockedByViewer, blocker] = [randomUUID(), randomUUID(), randomUUID()];
    await db.drizzle.db.insert(chatUserBlock).values([
      { blockerId: viewer, blockedId: blockedByViewer },
      { blockerId: blocker, blockedId: viewer },
    ]);

    for (const id of [viewer, blockedByViewer, blocker, randomUUID()]) {
      expect(await remote.getExcludedUserIds(id)).toEqual(
        await local.reader.getExcludedUserIds(id),
      );
      expect(await remote.getBlockedUserIds(id)).toEqual(await local.reader.getBlockedUserIds(id));
      expect(await remote.getBlockerIds(id)).toEqual(await local.reader.getBlockerIds(id));
    }
    expect(await remote.getBlockedUserIds(viewer)).toEqual([blockedByViewer]);
    expect(await remote.getBlockerIds(viewer)).toEqual([blocker]);
  });

  it('never answers from a cache: a block made after a read shows on the next', async () => {
    const { client } = chatService(MONEY);
    const remote = new RemoteChatBlockReader(client);
    const [viewer, other] = [randomUUID(), randomUUID()];

    expect(await remote.getBlockedUserIds(viewer)).toEqual([]);
    await db.drizzle.db.insert(chatUserBlock).values({ blockerId: viewer, blockedId: other });

    expect(await remote.getBlockedUserIds(viewer)).toEqual([other]);
  });

  it('is refused for a service not on CHAT_BLOCK_READER_CALLERS, and by default for every service', async () => {
    const stranger = new RemoteChatBlockReader(chatService('wallet').client);
    const unset = new RemoteChatBlockReader(chatService(MONEY, '').client);

    for (const remote of [stranger, unset]) {
      await expect(remote.getExcludedUserIds(randomUUID())).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
      await expect(remote.getBlockerIds(randomUUID())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('answers 503 for a stalled or failing chat service, never an empty list', async () => {
    const timeout = new RemoteChatBlockReader(overNetwork(stalled));
    const timeoutFailure = await settle(timeout.getExcludedUserIds(randomUUID()));
    const down = new RemoteChatBlockReader(
      overNetwork(async () => new Response('{}', { status: 502 })),
    );
    const downFailure = await settle(down.getBlockedUserIds(randomUUID()));
    const unreachable = new RemoteChatBlockReader(
      overNetwork(() => Promise.reject(new TypeError('fetch failed'))),
    );
    const unreachableFailure = await settle(unreachable.getBlockerIds(randomUUID()));

    for (const failure of [timeoutFailure, downFailure, unreachableFailure]) {
      expect(failure).toBeInstanceOf(ORPCError);
      expect(failure).toMatchObject({ code: 'SERVICE_UNAVAILABLE', status: 503 });
    }
  });

  it('leaves a refused 4xx a server error and rejects a reply off the wire schema', async () => {
    const refused = new RemoteChatBlockReader(
      overNetwork(async () => new Response('{}', { status: 403 })),
    );
    const refusedFailure = await settle(refused.getExcludedUserIds(randomUUID()));
    const garbled = new RemoteChatBlockReader({
      request: () => Promise.resolve({ userIds: ['not-a-uuid'] }),
    });

    expect(refusedFailure).toBeInstanceOf(InternalApiError);
    expect(refusedFailure).toMatchObject({ kind: 'client', status: 403 });
    await expect(garbled.getExcludedUserIds(randomUUID())).rejects.toThrow();
  });
});

describe('RemoteChatTransferCheck against the chat internal route', () => {
  it('answers as the local binding does, the blocked counterparts named', async () => {
    const { client, local } = chatService(MONEY);
    const remote = new RemoteChatTransferCheck(client);
    const [actorId, blockedByActor, clear] = [randomUUID(), randomUUID(), randomUUID()];
    await db.drizzle.db
      .insert(chatUserBlock)
      .values({ blockerId: actorId, blockedId: blockedByActor });
    const input = gift({ actorId, counterpartIds: [blockedByActor, clear] });

    const viaRemote = await remote.check(undefined, input);
    const viaLocal = await db.drizzle.db.transaction((tx) => local.check.check(tx, input));

    expect(viaRemote).toEqual(viaLocal);
    expect(viaRemote).toMatchObject({ allowed: true, blockedIds: [blockedByActor] });
  });

  it('passes a refusal chat answered with through unchanged', async () => {
    const { client } = chatService(MONEY);
    const remote = new RemoteChatTransferCheck(client);

    await expect(
      checkChatTransfer(remote, undefined, gift({ roomId: randomUUID() })),
    ).resolves.toEqual({
      allowed: false,
      refusal: 'room_not_found',
    });
  });

  it('does not touch the caller transaction: a bad input is the caller bug, not chat_unavailable', async () => {
    const { client } = chatService(MONEY);
    const remote = new RemoteChatTransferCheck(client);

    const bad = gift({ actorId: 'nope' });

    await expect(remote.check(undefined, bad)).rejects.toBeInstanceOf(z.ZodError);
    // Not turned into a refusal: the caller's bug must stay loud, not read as chat being down.
    await expect(checkChatTransfer(remote, undefined, bad)).rejects.toBeInstanceOf(z.ZodError);
  });

  it('refuses the transfer when the caller is not on CHAT_TRANSFER_CHECK_CALLERS or the list is unset', async () => {
    for (const service of [chatService('wallet'), chatService(MONEY, '')]) {
      const remote = new RemoteChatTransferCheck(service.client);

      await expect(checkChatTransfer(remote, undefined, gift())).resolves.toEqual({
        allowed: false,
        refusal: 'chat_unavailable',
      });
    }
  });

  it('refuses the transfer on a timeout, a 5xx, a dropped connection and an unreadable reply', async () => {
    const remotes = [
      new RemoteChatTransferCheck(overNetwork(stalled)),
      new RemoteChatTransferCheck(overNetwork(async () => new Response('{}', { status: 502 }))),
      new RemoteChatTransferCheck({ request: () => Promise.reject(new TypeError('fetch failed')) }),
      new RemoteChatTransferCheck({ request: () => Promise.resolve({ allowed: 'maybe' }) }),
    ];

    for (const remote of remotes) {
      await expect(remote.check(undefined, gift())).rejects.toMatchObject({
        name: 'ChatTransferCheckUnavailableError',
      });
      await expect(checkChatTransfer(remote, undefined, gift())).resolves.toEqual({
        allowed: false,
        refusal: 'chat_unavailable',
      });
    }
  });
});

describe('binding the chat ports', () => {
  it('chat refuses to boot while CHAT_SERVICE_URL is set: the ports would be bound twice', () => {
    process.env['CHAT_SERVICE_URL'] = 'https://chat.internal';
    const { registry } = newContainer();

    expect(() => chatPlugin.register(registry)).toThrow(/CHAT_SERVICE_URL is set/);
  });

  it('chat-remote binds both ports to the chat service once CHAT_SERVICE_URL is set', () => {
    process.env['CHAT_SERVICE_URL'] = 'https://chat.internal';
    const { container, registry } = newContainer();

    chatRemotePlugin.register(registry);

    expect(container.get(CHAT_BLOCK_READER)).toBeInstanceOf(RemoteChatBlockReader);
    expect(container.get(CHAT_TRANSFER_CHECK)).toBeInstanceOf(RemoteChatTransferCheck);
  });

  it('chat-remote binds nothing while CHAT_SERVICE_URL is unset', () => {
    const { container, registry } = newContainer();

    chatRemotePlugin.register(registry);

    expect(() => container.get(CHAT_BLOCK_READER)).toThrow();
    expect(() => container.get(CHAT_TRANSFER_CHECK)).toThrow();
  });

  it('chat-remote named in a manifest refuses to boot without CHAT_SERVICE_URL, naming the variable', () => {
    process.env['SERVICE_MANIFEST'] = 'player-management,chat-remote';

    expect(() => chatRemotePlugin.register(newContainer().registry)).toThrow(
      /set CHAT_SERVICE_URL/,
    );
  });

  it('chat-remote refuses a clear-text chat URL in production unless allowed', () => {
    process.env['CHAT_SERVICE_URL'] = 'http://chat.internal';
    process.env['NODE_ENV'] = 'production';

    expect(() => chatRemotePlugin.register(newContainer().registry)).toThrow(/not https/);

    process.env['CHAT_SERVICE_ALLOW_HTTP'] = 'true';
    expect(() => chatRemotePlugin.register(newContainer().registry)).not.toThrow();
  });
});
