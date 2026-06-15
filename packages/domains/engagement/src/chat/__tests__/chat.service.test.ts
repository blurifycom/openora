import { describe, it, expect } from 'vitest';
import { InProcessRealtimeTransport } from '@oss/core';
import type { EventBus } from '@oss/core';
import type { DrizzleService } from '@oss/db';
import type { ChatMessage } from '../schemas/index.js';
import {
  ChatService,
  chatChannel,
  ChatRoomNotFoundError,
  ChatMessageNotFoundError,
  ChatMessageOwnershipError,
} from '../service/chat.service.js';

describe('ChatService domain errors', () => {
  it('ChatRoomNotFoundError carries the id', () => {
    const err = new ChatRoomNotFoundError('room-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatRoomNotFoundError');
    expect(err.message).toContain('room-123');
  });

  it('ChatMessageNotFoundError carries the id', () => {
    const err = new ChatMessageNotFoundError('msg-456');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatMessageNotFoundError');
    expect(err.message).toContain('msg-456');
  });

  it('ChatMessageOwnershipError carries the id', () => {
    const err = new ChatMessageOwnershipError('msg-789');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('ChatMessageOwnershipError');
    expect(err.message).toContain('msg-789');
  });
});

describe('ChatService realtime wiring', () => {
  const sample: ChatMessage = {
    id: 'm1',
    roomId: 'r1',
    userId: 'u1',
    username: 'alice',
    content: 'hi',
    isDeleted: false,
    createdAt: '2026-05-29T00:00:00.000Z',
  };

  it('maps room vs global channels', () => {
    expect(chatChannel(null)).toBe('chat:global');
    expect(chatChannel('r1')).toBe('chat:room:r1');
  });

  it('delivers messages published on a room channel to subscribers, then stops on unsubscribe', () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(
      {} as DrizzleService,
      { emit: () => undefined } as unknown as EventBus,
      transport,
    );

    const got: ChatMessage[] = [];
    const unsub = service.subscribeMessages('r1', (m) => got.push(m));

    transport.publish(chatChannel('r1'), sample);
    expect(got).toEqual([sample]);

    transport.publish(chatChannel(null), { ...sample, roomId: null }); // global, not r1
    expect(got).toHaveLength(1);

    unsub();
    transport.publish(chatChannel('r1'), sample);
    expect(got).toHaveLength(1);
  });
});

describe('ChatService.sendGlobalMessage username resolution', () => {
  // Mock drizzle: the select chain (resolveDisplayName) returns the user row; the
  // insert chain echoes the values back as the stored row.
  function makeDb(userName: string | null) {
    return {
      select: () => ({
        from: () => ({
          where: () => ({ limit: async () => (userName ? [{ name: userName }] : []) }),
        }),
      }),
      insert: () => ({
        values: (v: { tenantId: string; userId: string; username: string; content: string }) => ({
          returning: async () => [
            {
              id: 'm1',
              tenantId: v.tenantId,
              roomId: null,
              userId: v.userId,
              username: v.username,
              content: v.content,
              isDeleted: false,
              createdAt: new Date('2026-06-01T00:00:00.000Z'),
            },
          ],
        }),
      }),
    };
  }

  it('stores the display name from the verified user, ignoring the header-derived fallback', async () => {
    const transport = new InProcessRealtimeTransport();
    const service = new ChatService(
      { db: makeDb('Platform Admin') } as unknown as DrizzleService,
      { emit: () => undefined } as unknown as EventBus,
      transport,
    );

    const msg = await service.sendGlobalMessage('u1', 'spoofed-header-name', 'hi', 't1');
    expect(msg.username).toBe('Platform Admin');
  });

  it('falls back to the passed name, then anonymous, when the user row is missing', async () => {
    const service = new ChatService(
      { db: makeDb(null) } as unknown as DrizzleService,
      { emit: () => undefined } as unknown as EventBus,
      new InProcessRealtimeTransport(),
    );
    expect((await service.sendGlobalMessage('u1', 'fallback', 'hi', 't1')).username).toBe(
      'fallback',
    );
    expect((await service.sendGlobalMessage('u1', '', 'hi', 't1')).username).toBe('anonymous');
  });
});
