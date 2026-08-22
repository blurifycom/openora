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
import type { ClientMeta, GeoIpAdapter, IdentityReader, User } from '@openora/core/contracts';

export const LimitNotFoundError = makeNotFoundError('Limit');

export const LimitOwnershipError = makeOwnershipError('Limit');

export const GeoRuleNotFoundError = makeNotFoundError('GeoRule');

export class ComplianceService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly geoIp: GeoIpAdapter | null,
    private readonly identityReader: IdentityReader,
  ) {}

  async getLimitsForUser(userId: User['id']) {
    const rows = await this.drizzle.db.select().from(userLimit).where(eq(userLimit.userId, userId));
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] }));
  }

  async upsertLimit(userId: User['id'], input: UpsertLimitInput, meta?: ClientMeta) {
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
    this.events.emit('compliance.limit.upserted', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      limitId: row.id,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return serializeRow(row, { dateFields: ['createdAt'] });
  }

  async removeLimit(id: string, userId: User['id'], meta?: ClientMeta): Promise<{ success: true }> {
    const existing = findOneOrThrow(
      await this.drizzle.db.select().from(userLimit).where(eq(userLimit.id, id)),
      new LimitNotFoundError(id),
    );
    assertOwnership(existing.userId, userId, new LimitOwnershipError());
    await this.drizzle.db.delete(userLimit).where(eq(userLimit.id, id));
    this.events.emit('compliance.limit.removed', {
      userId,
      playerId: await this.identityReader.getPlayerIdByUserIdSafe(userId),
      limitId: id,
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return { success: true };
  }

  async geoCheck(ipAddress: string | null) {
    const countryCode =
      this.geoIp && ipAddress ? (await this.geoIp.lookup(ipAddress)).countryCode : null;

    if (!countryCode) {
      // With rules configured, an unresolvable address is a gap in the gate, not a pass.
      const [anyRule] = await this.drizzle.db
        .select({ action: geoRule.action })
        .from(geoRule)
        .limit(1);
      return anyRule
        ? { allowed: false, countryCode: null, reason: 'Geolocation could not be determined' }
        : { allowed: true, countryCode: null, reason: null };
    }

    const [rule] = await this.drizzle.db
      .select({ action: geoRule.action })
      .from(geoRule)
      .where(eq(geoRule.countryCode, countryCode));

    if (rule?.action === 'block') {
      return { allowed: false, countryCode, reason: `Country ${countryCode} is blocked` };
    }

    return { allowed: true, countryCode, reason: null };
  }

  async checkRegistration(ipAddress: string | null) {
    const result = await this.geoCheck(ipAddress);
    return { allowed: result.allowed };
  }

  async addGeoRule(input: AddGeoRuleInput, actorId?: User['id'], meta?: ClientMeta) {
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
      ip: meta?.ip ?? null,
      userAgent: meta?.userAgent ?? null,
    });
    return serializeRow(row, { dateFields: ['createdAt'] });
  }

  async listGeoRules() {
    const rows = await this.drizzle.db.select().from(geoRule);
    return rows.map((r) => serializeRow(r, { dateFields: ['createdAt'] }));
  }
}
