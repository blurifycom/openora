import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { chatChannel, GLOBAL_CHAT_ROOM_ID } from '@openora/core/contracts';
import type { RealtimeClientStatus } from '@openora/core/react';
import { createChatSseRealtimeClientAdapter } from '../react/realtime-client.js';

const BASE_URL = 'http://api.test';

function recordingFetch() {
  const urls: string[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    urls.push(input instanceof Request ? input.url : String(input));
    return Response.json({ code: 'FORBIDDEN', status: 403, message: 'forbidden' }, { status: 403 });
  });
  return { fetch, urls };
}

async function subscribeUntilClosed(
  adapter: ReturnType<typeof createChatSseRealtimeClientAdapter>,
  channel: string,
) {
  const statuses: RealtimeClientStatus[] = [];
  adapter.subscribe(channel, { onMessage: () => {}, onStatus: (status) => statuses.push(status) });
  await vi.waitFor(() => expect(statuses.at(-1)).toBe('closed'));
}

describe('createChatSseRealtimeClientAdapter', () => {
  it('opens the combined room stream for a room channel', async () => {
    const { fetch, urls } = recordingFetch();
    const adapter = createChatSseRealtimeClientAdapter({ baseUrl: BASE_URL, fetch });
    const roomId = randomUUID();

    await subscribeUntilClosed(adapter, chatChannel(roomId));

    expect(urls).toEqual([`${BASE_URL}/chat/room-stream?roomId=${roomId}`]);
  });

  it('opens the global stream for the global channel and its room-id alias', async () => {
    const { fetch, urls } = recordingFetch();
    const adapter = createChatSseRealtimeClientAdapter({ baseUrl: BASE_URL, fetch });

    await subscribeUntilClosed(adapter, chatChannel(null));
    await subscribeUntilClosed(adapter, chatChannel(GLOBAL_CHAT_ROOM_ID));

    expect(urls).toEqual([`${BASE_URL}/chat/room-stream`, `${BASE_URL}/chat/room-stream`]);
  });

  it('rejects a channel that is not a chat channel without opening a stream', () => {
    const { fetch } = recordingFetch();
    const adapter = createChatSseRealtimeClientAdapter({ baseUrl: BASE_URL, fetch });

    expect(() => adapter.subscribe('wallet:balance:u1', { onMessage: () => {} })).toThrow(
      TypeError,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
