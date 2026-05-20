import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ComplianceService,
  LimitNotFoundError,
  LimitOwnershipError,
} from '../service/compliance.service.js';

// Minimal stub for PrismaService - typed as any in tests per repo rules
function makePrisma(overrides: Record<string, unknown> = {}) {
  return {
    userLimit: {
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      findUnique: vi.fn(),
      delete: vi.fn(),
      ...((overrides['userLimit'] as Record<string, unknown>) ?? {}),
    },
    geoRule: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      upsert: vi.fn(),
      ...((overrides['geoRule'] as Record<string, unknown>) ?? {}),
    },
  };
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

describe('ComplianceService', () => {
  describe('getLimitsForUser', () => {
    it('returns empty array when no limits exist', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(makePrisma() as any, makeEvents() as any);
      const result = await svc.getLimitsForUser('user-1');
      expect(result).toEqual([]);
    });
  });

  describe('removeLimit', () => {
    it('throws LimitNotFoundError when limit does not exist', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(makePrisma() as any, makeEvents() as any);
      await expect(svc.removeLimit('nonexistent', 'user-1')).rejects.toBeInstanceOf(
        LimitNotFoundError,
      );
    });

    it('throws LimitOwnershipError when limit belongs to another user', async () => {
      const prisma = makePrisma({
        userLimit: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'limit-1',
            userId: 'user-other',
            type: 'deposit',
            amount: 100,
            period: 'daily',
            createdAt: new Date(),
            updatedAt: new Date(),
          }),
          delete: vi.fn(),
        },
      });
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(prisma as any, makeEvents() as any);
      await expect(svc.removeLimit('limit-1', 'user-1')).rejects.toBeInstanceOf(
        LimitOwnershipError,
      );
    });
  });

  describe('geoCheck', () => {
    it('returns allowed: true when no geoIp port and no rule', async () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(makePrisma() as any, makeEvents() as any);
      const result = await svc.geoCheck('1.2.3.4');
      expect(result.allowed).toBe(true);
      expect(result.countryCode).toBeNull();
    });

    it('returns allowed: false for blocked country', async () => {
      const prisma = makePrisma({
        geoRule: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'rule-1',
            countryCode: 'US',
            action: 'block',
            createdAt: new Date(),
          }),
          findMany: vi.fn().mockResolvedValue([]),
          upsert: vi.fn(),
        },
      });
      const geoIp = { lookup: vi.fn().mockResolvedValue({ countryCode: 'US' }) };
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(prisma as any, makeEvents() as any, geoIp);
      const result = await svc.geoCheck('1.2.3.4');
      expect(result.allowed).toBe(false);
      expect(result.countryCode).toBe('US');
    });

    it('returns allowed: true for allowed country rule', async () => {
      const prisma = makePrisma({
        geoRule: {
          findUnique: vi.fn().mockResolvedValue({
            id: 'rule-2',
            countryCode: 'DE',
            action: 'allow',
            createdAt: new Date(),
          }),
          findMany: vi.fn().mockResolvedValue([]),
          upsert: vi.fn(),
        },
      });
      const geoIp = { lookup: vi.fn().mockResolvedValue({ countryCode: 'DE' }) };
      // oxlint-disable-next-line typescript/no-explicit-any
      const svc = new ComplianceService(prisma as any, makeEvents() as any, geoIp);
      const result = await svc.geoCheck('1.2.3.4');
      expect(result.allowed).toBe(true);
    });
  });
});
