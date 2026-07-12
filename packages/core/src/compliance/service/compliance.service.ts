import {
  DrizzleService,
  findOneOrThrow,
  type EventBus,
  makeNotFoundError,
  makeOwnershipError,
  assertOwnership,
  serializeRow,
} from '@openora/core/server';
import { eq } from 'drizzle-orm';
import { userLimit, geoRule } from '../schema/index.js';
import type { UpsertLimitInput, AddGeoRuleInput } from '../contract/index.js';
import { type GeoIpAdapter, type User } from '@openora/core/contracts';

export const LimitNotFoundError = makeNotFoundError('Limit');

export const LimitOwnershipError = makeOwnershipError('Limit');

export const GeoRuleNotFoundError = makeNotFoundError('GeoRule');

export class ComplianceService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly geoIp: GeoIpAdapter | null = null,
  ) {}

  async getLimitsForUser(userId: User['id']) {
    const rows = await this.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] }));
  }

  async upsertLimit(userId: User['id'], input: UpsertLimitInput) {
    const row = findOneOrThrow(
      await this.drizzle.db
        .insert(userLimit)
        .values({ ...input, userId })
        .onConflictDoUpdate({
          target: [userLimit.userId, userLimit.type, userLimit.period],
          set: { amount: input.amount, minutes: input.minutes },
        })
        .returning(),
      new LimitNotFoundError(userId),
    );
    this.events.emit('compliance.limit.upserted', { userId, limitId: row.id });
    return serializeRow(row, { dateFields: ['createdAt'] });
  }

  async removeLimit(id: string, userId: User['id']): Promise<{ success: true }> {
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
      .select({ action: geoRule.action })
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

  async addGeoRule(input: AddGeoRuleInput, actorId?: User['id']) {
    const row = findOneOrThrow(
      await this.drizzle.db
        .insert(geoRule)
        .values({ ...input })
        .onConflictDoUpdate({
          target: geoRule.countryCode,
          set: { action: input.action },
        })
        .returning(),
      new GeoRuleNotFoundError(input.countryCode),
    );
    this.events.emit('compliance.geo-rule.added', {
      countryCode: input.countryCode,
      action: input.action,
      actorId,
    });
    return serializeRow(row, { dateFields: ['createdAt'] });
  }

  async listGeoRules() {
    const rows = await this.drizzle.db.select().from(geoRule);
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] }));
  }
}
