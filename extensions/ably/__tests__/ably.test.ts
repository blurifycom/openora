import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AblyClientAuthorizer,
  type AblyTokenRequestClient,
  type AblyTokenRequestParams,
} from '../ably-client-authorizer.js';
import {
  AblyRealtimeTransport,
  type AblyLogger,
  type AblyPresencePage,
  type AblyRealtimeClient,
} from '../ably-realtime-transport.js';

function tokenClient() {
  const requests: AblyTokenRequestParams[] = [];
  const createTokenRequest = async (input: AblyTokenRequestParams) => {
    requests.push(input);
    return input;
  };
  const rest: AblyTokenRequestClient = { auth: { createTokenRequest } };
  return { rest, requests };
}

const log: AblyLogger = { warn: () => undefined };

function presencePage(clientIds: string[]): AblyPresencePage {
  return {
    items: clientIds.map((clientId) => ({ clientId })),
    hasNext: () => false,
    next: async () => presencePage([]),
  };
}

test('AblyClientAuthorizer grants only subscribe and presence on exact channels', async () => {
  const { rest, requests } = tokenClient();
  const grant = await new AblyClientAuthorizer(rest).issueGrant({
    userId: 'player-1',
    clientId: 'untrusted-browser-id',
    channels: ['chat:global', 'chat:room:private-room'],
  });

  assert.deepEqual(grant, {
    provider: 'ably',
    tokenRequest: requests[0],
    channels: ['chat:global', 'chat:room:private-room'],
  });
  const [input] = requests;
  assert.equal(input?.clientId, 'player-1');
  assert.deepEqual(JSON.parse(input?.capability ?? '{}'), {
    'chat:global': ['subscribe', 'presence'],
    'chat:room:private-room': ['subscribe', 'presence'],
  });
});

test('AblyClientAuthorizer mints an empty capability when no channels are authorized', async () => {
  const { rest, requests } = tokenClient();
  await new AblyClientAuthorizer(rest).issueGrant({
    userId: 'player-1',
    clientId: 'x',
    channels: [],
  });

  assert.equal(requests[0]?.capability, '{}');
});

test('AblyRealtimeTransport publishes messages and counts unique presence identities', async () => {
  const publications: { name: string; data: unknown }[] = [];
  const rest: AblyRealtimeClient = {
    channels: {
      get: () => ({
        publish: async (name: string, data: unknown) => {
          publications.push({ name, data });
        },
        presence: {
          get: async () => presencePage(['player-1', 'player-1', 'player-2']),
        },
      }),
    },
  };
  const transport = new AblyRealtimeTransport(rest, log);

  await transport.publish('chat:global', { id: 'message-1' });
  assert.equal(await transport.presence.count('chat:global'), 2);
  assert.deepEqual(publications, [{ name: 'message', data: { id: 'message-1' } }]);
});
