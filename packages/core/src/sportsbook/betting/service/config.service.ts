import { isDeepStrictEqual } from 'node:util';
import { eq } from 'drizzle-orm';
import {
  createDomainError,
  findOneOrThrow,
  makeNotFoundError,
  type AdminCaller,
  type DrizzleDb,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type { AuditWritePort } from '@openora/core/contracts';
import {
  SPORTSBOOK_CONFIG_DEFAULTS,
  type SportsbookConfig,
  type UpdateSportsbookConfigInput,
} from '../contract/index.js';
import { sportsbookConfig, type SportsbookConfigRow } from '../schema/index.js';
import { lockConfig } from './locks.service.js';

export const SportsbookConfigInvalidError = createDomainError<[]>(
  'SportsbookConfigInvalidError',
  () => 'Enabling sportsbook needs at least one currency',
  { reason: 'currency_required' },
);
const SportsbookConfigNotFoundError = makeNotFoundError('SportsbookConfig');

const SINGLETON_KEY = 'global';

const DEFAULT_SPORTSBOOK_CONFIG: SportsbookConfig = {
  enabled: false,
  suspended: false,
  currencies: [],
  blockedCountries: [],
  ...SPORTSBOOK_CONFIG_DEFAULTS,
  updatedAt: null,
};

function toConfig(row: SportsbookConfigRow | undefined): SportsbookConfig {
  if (!row) {
    return DEFAULT_SPORTSBOOK_CONFIG;
  }
  return {
    enabled: row.enabled,
    suspended: row.suspended,
    currencies: row.currencies,
    blockedCountries: row.blockedCountries,
    reserveTimeoutSeconds: row.reserveTimeoutSeconds,
    settlementGraceMinutes: row.settlementGraceMinutes,
    sessionTtlMinutes: row.sessionTtlMinutes,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class SportsbookConfigService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly audit: AuditWritePort,
  ) {}

  async get(db: DrizzleDb | DrizzleTx = this.drizzle.db): Promise<SportsbookConfig> {
    const [row] = await db
      .select()
      .from(sportsbookConfig)
      .where(eq(sportsbookConfig.singletonKey, SINGLETON_KEY));
    return toConfig(row);
  }

  async update(input: UpdateSportsbookConfigInput, actor: AdminCaller): Promise<SportsbookConfig> {
    if (input.enabled && input.currencies.length === 0) {
      throw new SportsbookConfigInvalidError();
    }
    return this.write({ actor, action: 'sportsbook.config.set', values: input, reason: null });
  }

  async setSuspended(
    suspended: boolean,
    reason: string,
    actor: AdminCaller,
  ): Promise<SportsbookConfig> {
    return this.write({
      actor,
      action: suspended ? 'sportsbook.config.suspended' : 'sportsbook.config.resumed',
      values: { suspended },
      reason,
    });
  }

  private async write({
    actor,
    action,
    values,
    reason,
  }: {
    actor: AdminCaller;
    action: 'sportsbook.config.set' | 'sportsbook.config.suspended' | 'sportsbook.config.resumed';
    values: Partial<Omit<SportsbookConfigRow, 'id' | 'singletonKey' | 'createdAt' | 'updatedAt'>>;
    reason: string | null;
  }): Promise<SportsbookConfig> {
    return this.drizzle.db.transaction(async (tx) => {
      await lockConfig(tx, 'exclusive');
      const before = await this.get(tx);
      const unchanged =
        before.updatedAt !== null &&
        isDeepStrictEqual(
          Object.fromEntries(Object.entries(before).filter(([key]) => Object.hasOwn(values, key))),
          values,
        );
      if (unchanged) {
        return before;
      }
      const rows = await tx
        .insert(sportsbookConfig)
        .values({ singletonKey: SINGLETON_KEY, ...values, updatedBy: actor.userId })
        .onConflictDoUpdate({
          target: sportsbookConfig.singletonKey,
          set: { ...values, updatedBy: actor.userId },
        })
        .returning();
      const row = findOneOrThrow(rows, new SportsbookConfigNotFoundError(SINGLETON_KEY));
      const after = toConfig(row);
      await this.audit.recordInTransaction(tx, {
        actorId: actor.userId,
        actorType: 'admin',
        action,
        resourceType: 'sportsbook_config',
        resourceId: row.id,
        before,
        after: reason === null ? after : { ...after, reason },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return after;
    });
  }
}
