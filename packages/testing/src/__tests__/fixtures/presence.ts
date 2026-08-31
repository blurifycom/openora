import { REALTIME_TRANSPORT, chatChannel } from '@openora/core/contracts';
import type { TestApp } from '../../index.js';

/**
 * Mark a user online in a chat channel via the real `RealtimePresence` the test app
 * binds (`RedisPubSubRealtimeTransport`'s process-local presence store) - no SSE
 * connection needed. `roomId` is `null` for global chat.
 */
export function markOnline(app: TestApp, roomId: string | null, userId: string): void {
  const transport = app.container.get(REALTIME_TRANSPORT);
  transport.presence?.join(chatChannel(roomId), userId, `conn-${userId}`);
}
