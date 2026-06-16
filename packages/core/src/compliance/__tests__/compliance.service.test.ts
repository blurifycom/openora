import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';

function makeDrizzle(selectResult: unknown[] = [], insertResult: unknown[] = []) {
  const db = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(selectResult),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    onConflictDoUpdate: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(insertResult),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
  };
  return { db } as unknown as import('@oss/core/server').DrizzleService;
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

describe('ComplianceService', () => {
  describe('getLimitsForUser', () => {
    it('returns empty array when no limits exist', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(makeDrizzle() as any, makeEvents() as any);
      const result = await svc.getLimitsForUser('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('removeLimit', () => {
    it('throws LimitNotFoundError when limit does not exist', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(makeDrizzle([]) as any, makeEvents() as any);
      await expect(svc.removeLimit('nonexistent', 'user-1')).rejects.toBeInstanceOf(
        LimitNotFoundError,
      );
    });

    it('throws LimitOwnershipError when limit belongs to another user', async () => {
      const drizzle = makeDrizzle([
        {
          id: 'limit-1',
          userId: 'user-other',
          type: 'deposit',
          amount: 100,
          period: 'daily',
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(drizzle as any, makeEvents() as any);
      await expect(svc.removeLimit('limit-1', 'user-1')).rejects.toBeInstanceOf(
        LimitOwnershipError,
      );
    });
  });

  describe('geoCheck', () => {
    it('returns allowed: true when no geoIp port and no rule', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(makeDrizzle([]) as any, makeEvents() as any);
      const result = await svc.geoCheck('1.2.3.4');
      expect(result.allowed).toBe(true);
      expect(result.countryCode).toBeNull();
    });

    it('returns allowed: false for blocked country', async () => {
      const drizzle = makeDrizzle([
        {
          id: 'rule-1',
          countryCode: 'US',
          action: 'block',
          createdAt: new Date(),
        },
      ]);
      const geoIp = { lookup: vi.fn().mockResolvedValue({ countryCode: 'US' }) };
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(drizzle as any, makeEvents() as any, geoIp);
      const result = await svc.geoCheck('1.2.3.4');
      expect(result.allowed).toBe(false);
      expect(result.countryCode).toBe('US');
    });

    it('returns allowed: true for allowed country rule', async () => {
      const drizzle = makeDrizzle([
        {
          id: 'rule-2',
          countryCode: 'DE',
          action: 'allow',
          createdAt: new Date(),
        },
      ]);
      const geoIp = { lookup: vi.fn().mockResolvedValue({ countryCode: 'DE' }) };
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(drizzle as any, makeEvents() as any, geoIp);
      const result = await svc.geoCheck('1.2.3.4');
      expect(result.allowed).toBe(true);
    });
  });
});
