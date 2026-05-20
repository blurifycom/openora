import { Injectable, Inject, Optional } from '@nestjs/common';
import { PrismaService } from '@oss/persistence';
import { type EventBus, EVENT_BUS } from '@oss/core';
import type { UpsertLimitInput, Limit, GeoRule, AddGeoRuleInput } from '../schemas/index.js';
import { type GeoIpPort, GEO_IP_PORT } from './ports.js';

export class LimitNotFoundError extends Error {
  constructor(id: string) {
    super(`Limit not found: ${id}`);
    this.name = 'LimitNotFoundError';
  }
}

export class LimitOwnershipError extends Error {
  constructor() {
    super('Limit does not belong to this user');
    this.name = 'LimitOwnershipError';
  }
}

@Injectable()
export class ComplianceService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(EVENT_BUS) private readonly events: EventBus,
    @Optional() @Inject(GEO_IP_PORT) private readonly geoIp: GeoIpPort | null = null,
  ) {}

  async getLimitsForUser(userId: string): Promise<Limit[]> {
    const rows = await this.prisma.userLimit.findMany({ where: { userId } });
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      type: r.type as Limit['type'],
      amount: r.amount,
      period: r.period as Limit['period'],
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async upsertLimit(userId: string, input: UpsertLimitInput): Promise<Limit> {
    const row = await this.prisma.userLimit.upsert({
      where: { userId_type_period: { userId, type: input.type, period: input.period } },
      create: { userId, type: input.type, amount: input.amount, period: input.period },
      update: { amount: input.amount },
    });
    this.events.emit('compliance.limit.upserted', { userId, limitId: row.id });
    return {
      id: row.id,
      userId: row.userId,
      type: row.type as Limit['type'],
      amount: row.amount,
      period: row.period as Limit['period'],
      createdAt: row.createdAt.toISOString(),
    };
  }

  async removeLimit(id: string, userId: string): Promise<{ success: true }> {
    const existing = await this.prisma.userLimit.findUnique({ where: { id } });
    if (!existing) throw new LimitNotFoundError(id);
    if (existing.userId !== userId) throw new LimitOwnershipError();
    await this.prisma.userLimit.delete({ where: { id } });
    this.events.emit('compliance.limit.removed', { userId, limitId: id });
    return { success: true };
  }

  async geoCheck(ipAddress: string): Promise<{
    allowed: boolean;
    countryCode: string | null;
    reason: string | null;
  }> {
    let countryCode: string | null = null;

    if (this.geoIp) {
      const result = await this.geoIp.lookup(ipAddress);
      countryCode = result.countryCode;
    }

    if (!countryCode) {
      return { allowed: true, countryCode: null, reason: null };
    }

    const rule = await this.prisma.geoRule.findUnique({ where: { countryCode } });
    if (!rule) {
      return { allowed: true, countryCode, reason: null };
    }

    if (rule.action === 'block') {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    return { allowed: true, countryCode, reason: null };
  }

  async addGeoRule(input: AddGeoRuleInput): Promise<GeoRule> {
    const row = await this.prisma.geoRule.upsert({
      where: { countryCode: input.countryCode },
      create: { countryCode: input.countryCode, action: input.action },
      update: { action: input.action },
    });
    return {
      id: row.id,
      countryCode: row.countryCode,
      action: row.action as GeoRule['action'],
      createdAt: row.createdAt.toISOString(),
    };
  }

  async listGeoRules(): Promise<GeoRule[]> {
    const rows = await this.prisma.geoRule.findMany();
    return rows.map((r) => ({
      id: r.id,
      countryCode: r.countryCode,
      action: r.action as GeoRule['action'],
      createdAt: r.createdAt.toISOString(),
    }));
  }
}
