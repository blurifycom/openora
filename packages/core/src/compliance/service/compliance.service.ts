import {
  DrizzleService,
  findOneOrThrow,
  type EventBus,
  makeNotFoundError,
  makeOwnershipError,
  assertOwnership,
  serializeRow,
} from '@blurifycom/core/server';
import { eq } from 'drizzle-orm';
import { userLimit, geoRule } from '../schema/index.js';
import type { UpsertLimitInput, Limit, GeoRule, AddGeoRuleInput } from '../contract/index.js';
import { type GeoIpAdapter } from '@blurifycom/core/contracts';

export const LimitNotFoundError = makeNotFoundError('Limit');

export const LimitOwnershipError = makeOwnershipError('Limit');

export class ComplianceService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly geoIp: GeoIpAdapter | null = null,
  ) {}

  async getLimitsForUser(userId: string) {
    const rows = await this.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      type: r.type as Limit['type'],
      amount: r.amount,
      period: r.period as Limit['period'],
      createdAt: r.createdAt.toISOString(),
    }));
  }

  async upsertLimit(userId: string, input: UpsertLimitInput) {
    const [row] = await this.drizzle.db
      .insert(userLimit)
      .values({ userId, type: input.type, amount: input.amount, period: input.period })
      .onConflictDoUpdate({
        target: [userLimit.userId, userLimit.type, userLimit.period],
        set: { amount: input.amount },
      })
      .returning();
    this.events.emit('compliance.limit.upserted', { userId, limitId: row!.id });
    return {
      id: row!.id,
      userId: row!.userId,
      type: row!.type as Limit['type'],
      amount: row!.amount,
      period: row!.period as Limit['period'],
      createdAt: row!.createdAt.toISOString(),
    };
  }

  async removeLimit(id: string, userId: string): Promise<{ success: true }> {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(userLimit).where(eq(userLimit.id, id)),
      new LimitNotFoundError(id),
    );
    assertOwnership(existing.userId, userId, new LimitOwnershipError());
    await this.drizzle.db.delete(userLimit).where(eq(userLimit.id, id));
    this.events.emit('compliance.limit.removed', { userId, limitId: id });
    return { success: true };
  }

  async geoCheck(ipAddress: string) {
    let countryCode: string | null = null;

    if (this.geoIp) {
      const result = await this.geoIp.lookup(ipAddress);
      countryCode = result.countryCode;
    }

    if (!countryCode) {
      return { allowed: true, countryCode: null, reason: null };
    }

    const [rule] = await this.drizzle.db
      .select()
      .from(geoRule)
      .where(eq(geoRule.countryCode, countryCode));

    if (!rule) {
      return { allowed: true, countryCode, reason: null };
    }

    if (rule.action === 'block') {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    return { allowed: true, countryCode, reason: null };
  }

  async addGeoRule(input: AddGeoRuleInput, actorId?: string) {
    const [row] = await this.drizzle.db
      .insert(geoRule)
      .values({ countryCode: input.countryCode, action: input.action })
      .onConflictDoUpdate({
        target: geoRule.countryCode,
        set: { action: input.action },
      })
      .returning();
    this.events.emit('compliance.geo-rule.added', {
      countryCode: input.countryCode,
      action: input.action,
      actorId,
    });
    return serializeRow(row!, { dateFields: ['createdAt'] }) as GeoRule;
  }

  async listGeoRules() {
    const rows = await this.drizzle.db.select().from(geoRule);
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] }) as GeoRule);
  }
}
