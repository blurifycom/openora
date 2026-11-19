import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CHAT_BLOCK_READER_ROUTES,
  CHAT_TRANSFER_CHECK_ROUTES,
  ChatBlockReaderWire,
  ChatTransferCheckWire,
} from '@openora/core/contracts';
import { createInternalClient, DRIZZLE, InternalApiError } from '@openora/core/server';
import { chatUserBlock } from '@openora/core/engagement/schema/chat';
import { chatCommandConfig } from '@openora/core/engagement/schema/chat-commands';
import { bootE2e, closeE2e, type TestApp, type TestDb } from '../index.js';

// The chat service, booted as an app, called over the signed internal API by two other services:
// the money service its allow-list names, and one it does not. A call to the chat origin is
// served by the app in process, headers and signature included.
const CHAT_ORIGIN = 'http://chat.internal';
const MONEY = 'money-e2e';
const OUTSIDER = 'wallet-e2e';
const SECRET = randomBytes(32).toString('hex');
const ENV = {
  INTERNAL_API_SECRETS: SECRET,
  SERVICE_NAME: 'chat',
  CHAT_BLOCK_READER_CALLERS: MONEY,
  CHAT_TRANSFER_CHECK_CALLERS: MONEY,
};

let db: TestDb;
let chat: TestApp;
const realFetch = globalThis.fetch;

const clientAs = (serviceName: string) =>
  createInternalClient({
    baseUrl: CHAT_ORIGIN,
    serviceName,
    audience: 'chat',
    secrets: SECRET,
    timeoutMs: 5_000,
  });

const transferInput = (actorId: string, counterpartIds: string[]) => ({
  actorId,
  roomId: null,
  counterpartIds,
  command: 'gift',
});

beforeAll(async () => {
  Object.assign(process.env, ENV);
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    return url.startsWith(CHAT_ORIGIN) ? chat.app.request(url, init) : realFetch(input, init);
  });
  ({ db, app: chat } = await bootE2e());
  await chat.container
    .get(DRIZZLE)
    .db.insert(chatCommandConfig)
    .values({ key: 'gift', label: 'gift' })
    .onConflictDoNothing();
}, 90_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  for (const key of Object.keys(ENV)) {
    delete process.env[key];
  }
  await closeE2e({ app: chat, db });
});

describe('chat internal routes over signed HTTP', () => {
  it('serves the block reads to the caller on CHAT_BLOCK_READER_CALLERS', async () => {
    const [viewer, blockedByViewer, blocker] = [randomUUID(), randomUUID(), randomUUID()];
    await chat.container
      .get(DRIZZLE)
      .db.insert(chatUserBlock)
      .values([
        { blockerId: viewer, blockedId: blockedByViewer },
        { blockerId: blocker, blockedId: viewer },
      ]);
    const money = clientAs(MONEY);
    const ask = async (route: keyof typeof CHAT_BLOCK_READER_ROUTES) =>
      ChatBlockReaderWire[route].output.parse(
        await money.request('POST', CHAT_BLOCK_READER_ROUTES[route], { userId: viewer }),
      ).userIds;

    expect(await ask('blocked')).toEqual([blockedByViewer]);
    expect(await ask('blockers')).toEqual([blocker]);
    expect(await ask('excluded')).toEqual([blockedByViewer]);
  });

  it('serves the transfer check to the caller on CHAT_TRANSFER_CHECK_CALLERS', async () => {
    const [actor, counterpart] = [randomUUID(), randomUUID()];
    await chat.container
      .get(DRIZZLE)
      .db.insert(chatUserBlock)
      .values({ blockerId: counterpart, blockedId: actor });

    const verdict = ChatTransferCheckWire.check.output.parse(
      await clientAs(MONEY).request(
        'POST',
        CHAT_TRANSFER_CHECK_ROUTES.check,
        transferInput(actor, [counterpart]),
      ),
    );

    expect(verdict).toMatchObject({ allowed: true, blockedIds: [counterpart] });
  });

  it('refuses a signed caller that is not on either allow-list with a 403', async () => {
    const outsider = clientAs(OUTSIDER);
    const refusals = await Promise.all([
      ...Object.values(CHAT_BLOCK_READER_ROUTES).map((route) =>
        outsider.request('POST', route, { userId: randomUUID() }).catch((err: unknown) => err),
      ),
      outsider
        .request('POST', CHAT_TRANSFER_CHECK_ROUTES.check, transferInput(randomUUID(), []))
        .catch((err: unknown) => err),
    ]);

    for (const refusal of refusals) {
      expect(refusal).toBeInstanceOf(InternalApiError);
      expect(refusal).toMatchObject({ kind: 'client', status: 403 });
    }
  });

  it('refuses an unsigned call: the routes are not a public surface', async () => {
    const res = await chat.app.request(`/internal/v1${CHAT_BLOCK_READER_ROUTES.excluded}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: randomUUID() }),
    });

    expect(res.status).toBe(401);
  });
});
