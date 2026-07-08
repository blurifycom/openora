import { describe, it, expect, vi } from 'vitest';
import type { DrizzleService } from '@openora/core/server';
import { mock, mockDb } from '../../../testing/mock.js';
import { LoginEnforcementService } from '../service/login-enforcement.service.js';
import type { SessionService } from '../service/session.service.js';

function captureDb() {
  const sets: unknown[] = [];
  const db = {
    update: () => ({
      set: (s: unknown) => {
        sets.push(s);
        return { where: () => Promise.resolve(undefined) };
      },
    }),
  };
  return { drizzle: mockDb(db) as DrizzleService, sets };
}

function makeSessions() {
  return mock<SessionService>({ revokeAllSessions: vi.fn().mockResolvedValue({ success: true }) });
}

describe('LoginEnforcementService', () => {
  it('block sets the RG columns and revokes all sessions', async () => {
    const { drizzle, sets } = captureDb();
    const sessions = makeSessions();
    const until = new Date('2026-08-01T00:00:00.000Z');
    await new LoginEnforcementService(drizzle, sessions).block('u1', { until });
    expect(sets[0]).toEqual({ rgBlocked: true, rgBlockedUntil: until });
    expect(sessions.revokeAllSessions).toHaveBeenCalledWith('u1');
  });

  it('block with until:null sets an indefinite block', async () => {
    const { drizzle, sets } = captureDb();
    await new LoginEnforcementService(drizzle, makeSessions()).block('u1', { until: null });
    expect(sets[0]).toEqual({ rgBlocked: true, rgBlockedUntil: null });
  });

  it('unblock clears the RG columns', async () => {
    const { drizzle, sets } = captureDb();
    const sessions = makeSessions();
    await new LoginEnforcementService(drizzle, sessions).unblock('u1');
    expect(sets[0]).toEqual({ rgBlocked: false, rgBlockedUntil: null });
    expect(sessions.revokeAllSessions).not.toHaveBeenCalled();
  });
});
