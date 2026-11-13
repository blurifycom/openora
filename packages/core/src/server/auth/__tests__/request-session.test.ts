import { describe, it, expect, vi } from 'vitest';
import { resolveSessionChain, type SessionChainPorts } from '../request-session.js';

const session = { userId: 'u1', sessionId: 's1' };

function ports(overrides: Partial<SessionChainPorts> = {}) {
  const built: SessionChainPorts = {
    sessions: { resolveSession: vi.fn(async () => session) },
    idlePolicy: { touch: vi.fn(async () => 'active' as const) },
    twoFactorPolicy: { isSetupRequired: vi.fn(async () => false) },
    activity: { touchLastSeen: vi.fn(async () => undefined) },
    ...overrides,
  };
  return built;
}
const run = (built: SessionChainPorts) => resolveSessionChain(() => built, new Headers());

describe('resolveSessionChain', () => {
  it('resolves the session, touches the idle clock, checks 2FA and stamps last-seen, in that order', async () => {
    const order: string[] = [];
    const built = ports({
      sessions: {
        resolveSession: vi.fn(async () => {
          order.push('session');
          return session;
        }),
      },
      idlePolicy: {
        touch: vi.fn(async () => {
          order.push('idle');
          return 'active' as const;
        }),
      },
      twoFactorPolicy: {
        isSetupRequired: vi.fn(async () => {
          order.push('2fa');
          return false;
        }),
      },
      activity: {
        touchLastSeen: vi.fn(async () => {
          order.push('seen');
        }),
      },
    });

    expect(await run(built)).toEqual({ auth: session });
    expect(order).toEqual(['session', 'idle', '2fa', 'seen']);
    expect(built.idlePolicy?.touch).toHaveBeenCalledWith('u1', 's1');
  });

  it('touches nothing for a request with no session', async () => {
    const built = ports({ sessions: { resolveSession: vi.fn(async () => undefined) } });

    expect(await run(built)).toEqual({});
    expect(built.idlePolicy?.touch).not.toHaveBeenCalled();
    expect(built.activity?.touchLastSeen).not.toHaveBeenCalled();
  });

  it('says why when the idle window ended the session, and stamps nothing', async () => {
    const built = ports({ idlePolicy: { touch: vi.fn(async () => 'idle' as const) } });

    expect(await run(built)).toEqual({ sessionEndedReason: 'idle_timeout' });
    expect(built.activity?.touchLastSeen).not.toHaveBeenCalled();
  });

  it('treats an expired session, and an idle check that throws, as unauthenticated', async () => {
    const expired = ports({ idlePolicy: { touch: vi.fn(async () => 'expired' as const) } });
    const broken = ports({
      idlePolicy: {
        touch: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    });

    expect(await run(expired)).toEqual({});
    expect(await run(broken)).toEqual({});
  });

  it('publishes the second-factor enrolment flag only while it is owed', async () => {
    const owed = ports({ twoFactorPolicy: { isSetupRequired: vi.fn(async () => true) } });

    expect(await run(owed)).toEqual({ auth: { ...session, twoFactorSetupRequired: true } });
    expect(await run(ports())).toEqual({ auth: session });
  });

  it('treats a failed 2FA check as unauthenticated', async () => {
    const built = ports({
      twoFactorPolicy: {
        isSetupRequired: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    });

    expect(await run(built)).toEqual({});
    expect(built.activity?.touchLastSeen).not.toHaveBeenCalled();
  });

  it('serves the request even when the last-seen stamp fails', async () => {
    const built = ports({
      activity: {
        touchLastSeen: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    });

    expect(await run(built)).toEqual({ auth: session });
  });

  it('skips a check whose port is not bound', async () => {
    const built = ports({
      idlePolicy: undefined,
      twoFactorPolicy: undefined,
      activity: undefined,
    });

    expect(await run(built)).toEqual({ auth: session });
  });

  it('skips the idle check for a session with no id', async () => {
    const built = ports({ sessions: { resolveSession: vi.fn(async () => ({ userId: 'u1' })) } });

    expect(await run(built)).toEqual({ auth: { userId: 'u1' } });
    expect(built.idlePolicy?.touch).not.toHaveBeenCalled();
  });
});
