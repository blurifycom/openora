// @vitest-environment jsdom
import { createElement, type ReactNode } from 'react';
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
  RealtimeClientProvider,
  useOptionalRealtimeClient,
  type RealtimeClientAdapter,
  type RealtimeSubscribeHandlers,
} from '../realtime-client.js';

type Message = { id: string };

/**
 * Stands in for a vendor adapter: it records what each channel was subscribed with, and
 * `deliver`/`emit` play the two lanes back the way Ably's named events would. `subscribe` is
 * generic, so the map cannot know a channel's payload type - it stores the handlers under
 * `never`, which every `RealtimeSubscribeHandlers<T>` satisfies. Only `deliver` states a
 * payload type, and it is the one this file subscribes with.
 */
function fakeAdapter() {
  const channels = new Map<string, RealtimeSubscribeHandlers<never>>();
  const closed = vi.fn();
  const adapter: RealtimeClientAdapter = {
    subscribe<T>(channel: string, handlers: RealtimeSubscribeHandlers<T>) {
      channels.set(channel, handlers);
      return () => channels.delete(channel);
    },
    close: closed,
  };
  return {
    adapter,
    closed,
    deliver: (channel: string, message: Message) =>
      channels.get(channel)?.onMessage(message as never),
    emit: (channel: string, name: string, payload: unknown) =>
      channels.get(channel)?.onSignal?.(name, payload),
  };
}

function mountWith(adapter: RealtimeClientAdapter) {
  return renderHook(() => useOptionalRealtimeClient(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(RealtimeClientProvider, { adapter, children }),
  });
}

describe('RealtimeClientProvider', () => {
  it('returns null when no provider is mounted, so the caller can fall back to SSE', () => {
    expect(renderHook(() => useOptionalRealtimeClient()).result.current).toBeNull();
  });

  it('hands the mounted adapter to consumers and closes it on unmount', () => {
    const { adapter, closed } = fakeAdapter();
    const { result, unmount } = mountWith(adapter);

    expect(result.current).toBe(adapter);
    expect(closed).not.toHaveBeenCalled();
    unmount();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('delivers a named signal to onSignal and never to the payload lane', () => {
    const { adapter, deliver, emit } = fakeAdapter();
    const onMessage = vi.fn();
    const onSignal = vi.fn();
    const { result } = mountWith(adapter);

    result.current?.subscribe<Message>('chat:room:r1', { onMessage, onSignal });
    emit('chat:room:r1', 'chat:member-role-changed', {
      roomId: 'r1',
      userId: 'u1',
      role: 'moderator',
    });
    deliver('chat:room:r1', { id: 'm1' });

    expect(onSignal.mock.calls).toEqual([
      ['chat:member-role-changed', { roomId: 'r1', userId: 'u1', role: 'moderator' }],
    ]);
    expect(onMessage.mock.calls).toEqual([[{ id: 'm1' }]]);
  });

  it('leaves a caller that only wants messages unaffected by a signal', () => {
    const { adapter, deliver, emit } = fakeAdapter();
    const onMessage = vi.fn();
    const { result } = mountWith(adapter);

    // No onSignal: an SSE-backed adapter never calls it, and a caller need not supply it.
    result.current?.subscribe<Message>('chat:room:r1', { onMessage });

    expect(() => emit('chat:room:r1', 'chat:member-role-changed', {})).not.toThrow();
    deliver('chat:room:r1', { id: 'm1' });
    expect(onMessage.mock.calls).toEqual([[{ id: 'm1' }]]);
  });
});
