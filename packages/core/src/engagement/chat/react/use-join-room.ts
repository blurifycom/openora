'use client';

import { useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useOptionalRealtimeClient } from '@openora/core/react';
import type { ChatRoom } from '../contract/index.js';

/**
 * Joins a private room by join code, then refreshes both the room list cache and the
 * realtime connection token so the new channel is included in the next Ably/vendor grant.
 *
 * Usage:
 *   const join = useJoinRoom((input) => client.chat.joinRoom(input));
 *   await join('ABC123');
 */
export function useJoinRoom(
  joinRoomFn: (input: { joinCode: string }) => Promise<ChatRoom>,
): (joinCode: string) => Promise<ChatRoom> {
  const queryClient = useQueryClient();
  const adapter = useOptionalRealtimeClient();

  return useCallback(
    async (joinCode: string): Promise<ChatRoom> => {
      const room = await joinRoomFn({ joinCode });
      // Refresh the vendor token first so the new channel is authorised before the
      // room list re-renders and the consumer subscribes to it (BF-75 / ADR-0007).
      adapter?.refresh?.();
      void queryClient.invalidateQueries({ queryKey: ['chat', 'rooms'] });
      return room;
    },
    [joinRoomFn, queryClient, adapter],
  );
}
