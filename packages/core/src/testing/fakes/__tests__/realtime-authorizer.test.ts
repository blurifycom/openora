import { describe, it, expect } from 'vitest';
import { SseClientAuthorizer } from '../realtime-authorizer.js';

describe('SseClientAuthorizer', () => {
  it('issues an SSE grant with the default stream path and the granted channels', () => {
    const auth = new SseClientAuthorizer();
    const grant = auth.issueGrant({ userId: 'u1', clientId: 'u1', channels: ['chat:global'] });
    expect(grant).toEqual({
      provider: 'sse',
      streamPath: '/chat/stream',
      channels: ['chat:global'],
    });
  });

  it('honors a custom stream path', () => {
    const auth = new SseClientAuthorizer({ streamPath: '/live' });
    const grant = auth.issueGrant({ userId: 'u1', clientId: 'c9', channels: [] });
    expect(grant).toMatchObject({ provider: 'sse', streamPath: '/live' });
  });
});
