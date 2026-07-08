import { describe, it, expect, vi } from 'vitest';
import { mock, mockDb } from '../../../testing/mock.js';
import type { EventBus } from '@openora/core/server';
import type { AdminPermissionResolver } from '@openora/core/contracts';
import { AdminGuard } from '../admin-guard.js';
import type { SessionResolver } from '../session-resolver.js';

describe('AdminGuard - unauthorized access logging', () => {
  it('emits identity.user.unauthorized_access when dynamic permission check fails', async () => {
    const drizzle = mockDb({
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'u1', role: 'admin' }],
      }),
    });
    const sessions = mock<SessionResolver>({
      resolveUserId: vi.fn().mockResolvedValue('u1'),
    });
    const permissionResolver = mock<AdminPermissionResolver>({
      getGrants: vi.fn().mockResolvedValue([]),
    });
    const events = mock<EventBus>({
      emit: vi.fn(),
    });

    const guard = new AdminGuard(drizzle, sessions, permissionResolver, events);
    const context = {
      request: {
        headers: {
          'x-real-ip': '127.0.0.1',
          'user-agent': 'Mozilla/5.0',
        },
      },
    };

    await expect(guard.assert(context, 'admin', 'delete')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );

    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId: 'u1',
        resource: 'admin',
        action: 'delete',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
        role: 'admin',
      }),
    );
  });

  it('emits identity.user.unauthorized_access when static role permission check fails', async () => {
    const drizzle = mockDb({
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'u1', role: 'support' }],
      }),
    });
    const sessions = mock<SessionResolver>({
      resolveUserId: vi.fn().mockResolvedValue('u1'),
    });
    const events = mock<EventBus>({
      emit: vi.fn(),
    });

    const guard = new AdminGuard(drizzle, sessions, undefined, events);
    const context = {
      request: {
        headers: {
          'x-forwarded-for': '192.168.1.1, 10.0.0.1',
          'user-agent': 'Mozilla/5.0',
        },
      },
    };

    await expect(guard.assert(context, 'admin', 'delete')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );

    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId: 'u1',
        resource: 'admin',
        action: 'delete',
        ip: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        role: 'support',
      }),
    );
  });

  it('emits identity.user.unauthorized_access when user has no static role (e.g. player role)', async () => {
    const drizzle = mockDb({
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'u1', role: 'player' }],
      }),
    });
    const sessions = mock<SessionResolver>({
      resolveUserId: vi.fn().mockResolvedValue('u1'),
    });
    const events = mock<EventBus>({
      emit: vi.fn(),
    });

    const guard = new AdminGuard(drizzle, sessions, undefined, events);
    const context = {
      request: {
        headers: {
          'x-real-ip': '127.0.0.1',
          'user-agent': 'Mozilla/5.0',
        },
      },
    };

    await expect(guard.assert(context, 'admin', 'delete')).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );

    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId: 'u1',
        resource: 'admin',
        action: 'delete',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
        role: 'player',
      }),
    );
  });

  it('emits identity.user.unauthorized_access with default admin:access when coarse check fails for player role', async () => {
    const drizzle = mockDb({
      execute: vi.fn().mockResolvedValue({
        rows: [{ id: 'u1', role: 'player' }],
      }),
    });
    const sessions = mock<SessionResolver>({
      resolveUserId: vi.fn().mockResolvedValue('u1'),
    });
    const events = mock<EventBus>({
      emit: vi.fn(),
    });

    const guard = new AdminGuard(drizzle, sessions, undefined, events);
    const context = {
      request: {
        headers: {
          'x-real-ip': '127.0.0.1',
          'user-agent': 'Mozilla/5.0',
        },
      },
    };

    await expect(guard.assert(context)).rejects.toThrow(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );

    expect(events.emit).toHaveBeenCalledWith(
      'identity.user.unauthorized_access',
      expect.objectContaining({
        userId: 'u1',
        resource: 'admin',
        action: 'access',
        ip: '127.0.0.1',
        userAgent: 'Mozilla/5.0',
        role: 'player',
      }),
    );
  });
});
