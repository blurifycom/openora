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
