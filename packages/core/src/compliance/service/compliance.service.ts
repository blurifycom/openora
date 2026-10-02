import {
  DrizzleService,
  findOneOrThrow,
  pageToOffset,
  makeConflictError,
  makeNotFoundError,
  makeOwnershipError,
  moneyEquals,
  serializeRow,
  withAdvisoryXactLock,
  withAdvisoryXactLocks,
  type DrizzleTx,
  type EventBus,
} from '@openora/core/server';
import { and, asc, count, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  countryRule,
  gameGeoRule,
  globalKycConfig,
  GLOBAL_KYC_ENABLED_DEFAULT,
  GLOBAL_KYC_CUMULATIVE_DEPOSIT_THRESHOLD_DEFAULT,
  providerGeoRule,
} from '../schema/index.js';
import type {
  AddGeoRuleInput,
  BulkGameGeoRuleInput,
  BulkRestrictGameGeoRulesOutput,
  BulkUnrestrictGameGeoRulesOutput,
  DeleteGameGeoRulesInput,
  DeleteProviderGeoRulesInput,
  UpsertGameGeoRulesInput,
  UpsertProviderGeoRulesInput,
  ListGameGeoRulesInput,
  ListProviderGeoRulesInput,
  SetGlobalKycConfigInput,
  UpsertCountryRuleInput,
} from '../contract/index.js';
import {
  GAME_BULK_CAP,
  GameBulkTooManyGamesError,
  normalizeCountryCode,
  type AuditWritePort,
  type CacheAdapter,
  type ClientMeta,
  type GameGeoCheckInput,
  type GeoIpAdapter,
  type GeoRuleAction,
  type IgamingConfig,
  type MirrorTargetPolicy,
  type User,
} from '@openora/core/contracts';
import { game, gameProvider } from '@openora/core/casino/schema/gaming';

export const LimitNotFoundError = makeNotFoundError('Limit');

export const LimitOwnershipError = makeOwnershipError('Limit');

export const CountryRuleNotFoundError = makeNotFoundError('CountryRule');

export const GlobalKycConfigNotFoundError = makeNotFoundError('GlobalKycConfig');

export const CountryRuleVersionConflictError = makeConflictError(
  'CountryRuleVersionConflictError',
  'Country rule has changed. Refresh and try again.',
  { reason: 'stale_version' },
);

export const GlobalKycConfigVersionConflictError = makeConflictError(
  'GlobalKycConfigVersionConflictError',
  'Global KYC configuration has changed. Refresh and try again.',
  { reason: 'stale_version' },
);

export const LicensedJurisdictionBlacklistError = makeConflictError(
  'LicensedJurisdictionBlacklistError',
  'A licensed jurisdiction cannot be blacklisted.',
  { reason: 'licensed_jurisdiction' },
);

export const MirrorTargetNotApprovedError = makeConflictError(
  'MirrorTargetNotApprovedError',
  'This mirror URL is not an approved mirror domain',
  { reason: 'mirror_not_approved' },
);

export const CountryRuleConfirmationRequiredError = makeConflictError(
  'CountryRuleConfirmationRequiredError',
  'Confirmation is required to change a country rule.',
  { reason: 'confirmation_required' },
);

const COUNTRY_RULE_FIELDS = ['blacklisted', 'redirectIp', 'mirrorUrl', 'kycRequired'] as const;

type CountryRuleSettings = Pick<
  UpsertCountryRuleInput,
  'blacklisted' | 'redirectIp' | 'kycRequired'
> & {
  mirrorUrl: string | null;
};

// Redirection needs both the toggle and a target; either alone changes nothing.
function mirrorTargetOf(rule: { redirectIp: boolean; mirrorUrl: string | null }) {
  return rule.redirectIp ? rule.mirrorUrl : null;
}

// A blacklisted country that is redirected plays on the mirror, so the API lets it through
// and keeping it off the primary domain is left to whoever serves that domain.
function deniesAccess(rule: {
  blacklisted: boolean;
  redirectIp: boolean;
  mirrorUrl: string | null;
}) {
  return rule.blacklisted && mirrorTargetOf(rule) === null;
}

const countryRuleDeniesAccess = and(
  eq(countryRule.action, 'block'),
  or(eq(countryRule.redirectIp, false), isNull(countryRule.mirrorUrl)),
);

function hasCountryRuleChanges(before: typeof countryRule.$inferSelect, next: CountryRuleSettings) {
  return COUNTRY_RULE_FIELDS.some((field) => countryRuleFieldValue(before, field) !== next[field]);
}

// A change needs `confirm` when it moves a country on or off the blacklist, lets a denied
// country in, sends a blacklisted country to a different mirror, or drops KYC. Closing
// access - turning a mirror off on a blacklisted country - never does.
function needsConfirmation(before: typeof countryRule.$inferSelect, next: CountryRuleSettings) {
  const prior = { ...before, blacklisted: before.action === 'block' };
  const nextTarget = mirrorTargetOf(next);
  return (
    prior.blacklisted !== next.blacklisted ||
    (deniesAccess(prior) && !deniesAccess(next)) ||
    (next.blacklisted && nextTarget !== null && nextTarget !== mirrorTargetOf(prior)) ||
    (before.kycRequired && !next.kycRequired)
  );
}

function effectiveAccessOf(rule: CountryRuleSettings, isDeploymentBlocked: boolean) {
  if (isDeploymentBlocked || deniesAccess(rule)) {
    return 'blocked' as const;
  }
  return mirrorTargetOf(rule) === null ? ('open' as const) : ('redirected' as const);
}

function countryRuleFieldValue(
  row: typeof countryRule.$inferSelect,
  field: (typeof COUNTRY_RULE_FIELDS)[number],
) {
  return field === 'blacklisted' ? row.action === 'block' : row[field];
}

function moneyEqualsOrBothNull(a: string | null, b: string | null) {
  return a === null || b === null ? a === b : moneyEquals(a, b);
}

function hasExpectedVersion(actual: Date | null, expected: string | null) {
  return (actual ? actual.toISOString() : null) === expected;
}

function toCountryRuleView(row: typeof countryRule.$inferSelect, isDeploymentBlocked: boolean) {
  const settings = { ...row, blacklisted: row.action === 'block' };
  return {
    id: row.id,
    countryCode: row.countryCode,
    blacklisted: settings.blacklisted,
    redirectIp: row.redirectIp,
    mirrorUrl: row.mirrorUrl,
    effectiveAccess: effectiveAccessOf(settings, isDeploymentBlocked),
    kycRequired: row.kycRequired,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
  };
}

function toGlobalKycConfigView(row: typeof globalKycConfig.$inferSelect) {
  return {
    enabled: row.enabled,
    withdrawalThreshold: row.withdrawalThreshold,
    cumulativeDepositThreshold: row.cumulativeDepositThreshold,
    updatedAt: row.updatedAt?.toISOString() ?? null,
    updatedBy: row.updatedBy,
  };
}

function toGeoRuleView(row: typeof countryRule.$inferSelect) {
  return {
    id: row.id,
    countryCode: row.countryCode,
    action: row.action as GeoRuleAction,
    createdAt: row.createdAt.toISOString(),
  };
}

export const GameGeoRuleNotFoundError = makeNotFoundError('GameGeoRule');

export const GeoRuleGameNotFoundError = makeNotFoundError('Game');

function gameGeoRuleLockKey(
  gameId: UpsertGameGeoRulesInput['gameId'],
  countryCode: UpsertGameGeoRulesInput['countryCodes'][number],
): string {
  return `game-geo-rule:${gameId}:${countryCode}`;
}

// Bulk writers take this exclusive; single-target writers take it shared, before their
// per-(game, country) keys.
function gameGeoRuleCountryLockKey(countryCode: string): string {
  return `game-geo-rule-country:${countryCode}`;
}

function withGameGeoRuleLocks<T>(
  tx: DrizzleTx,
  gameId: UpsertGameGeoRulesInput['gameId'],
  countryCodes: UpsertGameGeoRulesInput['countryCodes'],
  fn: () => Promise<T>,
): Promise<T> {
  return withAdvisoryXactLocks(
    tx,
    countryCodes.map(gameGeoRuleCountryLockKey),
    () =>
      withAdvisoryXactLocks(
        tx,
        countryCodes.map((countryCode) => gameGeoRuleLockKey(gameId, countryCode)),
        fn,
      ),
    'shared',
  );
}

function bulkGameGeoTargetCondition(gameIds: string[], providerIds: string[]): SQL | undefined {
  return or(
    gameIds.length > 0 ? inArray(game.id, gameIds) : undefined,
    providerIds.length > 0 ? inArray(game.providerId, providerIds) : undefined,
  );
}

async function resolveBulkGeoScope(
  tx: DrizzleTx,
  gameIds: string[],
  providerIds: string[],
  limit: number,
): Promise<{
  games: { id: string; providerId: string }[];
  notFoundGameIds: string[];
  notFoundProviderIds: string[];
}> {
  const games = await tx
    .select({ id: game.id, providerId: game.providerId })
    .from(game)
    .where(bulkGameGeoTargetCondition(gameIds, providerIds))
    .limit(limit);
  const foundGameIds = new Set(games.map((row) => row.id));
  const notFoundGameIds = gameIds.filter((id) => !foundGameIds.has(id)).sort();

  const foundProviderIds =
    providerIds.length > 0
      ? new Set(
          (
            await tx
              .select({ id: gameProvider.id })
              .from(gameProvider)
              .where(inArray(gameProvider.id, providerIds))
          ).map((row) => row.id),
        )
      : new Set<string>();
  const notFoundProviderIds = providerIds.filter((id) => !foundProviderIds.has(id)).sort();

  return { games, notFoundGameIds, notFoundProviderIds };
}

async function assertWithinGeoCap(
  tx: DrizzleTx,
  gameIds: string[],
  providerIds: string[],
  scopeLength: number,
): Promise<void> {
  if (scopeLength <= GAME_BULK_CAP) {
    return;
  }
  const [{ n }] = await tx
    .select({ n: count() })
    .from(game)
    .where(bulkGameGeoTargetCondition(gameIds, providerIds));
  throw new GameBulkTooManyGamesError(Number(n), GAME_BULK_CAP);
}

export const ProviderGeoRuleNotFoundError = makeNotFoundError('ProviderGeoRule');

export const GeoRuleProviderNotFoundError = makeNotFoundError('GameProvider');

function providerGeoRuleLockKey(
  providerId: UpsertProviderGeoRulesInput['providerId'],
  countryCode: UpsertProviderGeoRulesInput['countryCodes'][number],
): string {
  return `provider-geo-rule:${providerId}:${countryCode}`;
}

function missingCountryCodes(requested: string[], rows: { countryCode: string }[]) {
  const found = new Set(rows.map((row) => row.countryCode));
  return requested.filter((countryCode) => !found.has(countryCode));
}

function serializeGeoRule<Rule extends { createdAt: Date; updatedAt: Date }>(rule: Rule) {
  return serializeRow(rule, { dateFields: ['createdAt', 'updatedAt'] });
}

function serializeBulkGeoRules(rows: (typeof gameGeoRule.$inferSelect)[]) {
  return rows.map(serializeGeoRule).sort((a, b) => a.gameId.localeCompare(b.gameId));
}

function pairGeoRuleChanges<Rule extends { countryCode: string; createdAt: Date; updatedAt: Date }>(
  before: Rule[],
  after: Rule[],
) {
  const beforeByCountry = new Map(before.map((row) => [row.countryCode, serializeGeoRule(row)]));
  return after
    .map((row) => ({
      before: beforeByCountry.get(row.countryCode) ?? null,
      after: serializeGeoRule(row),
    }))
    .sort((a, b) => a.after.countryCode.localeCompare(b.after.countryCode));
}

const VISITOR_GEO_BLOCK_AUDIT_WINDOW_MS = 60 * 60 * 1000;

export class ComplianceService {
  constructor(
    private readonly drizzle: DrizzleService,
    private readonly events: EventBus,
    private readonly geoIp: GeoIpAdapter | null,
    private readonly audit: AuditWritePort,
    private readonly igaming: IgamingConfig | null = null,
    private readonly cache: CacheAdapter | null = null,
    private readonly mirrorTargetPolicy: MirrorTargetPolicy | null = null,
  ) {}

  private countryRuleView(row: typeof countryRule.$inferSelect) {
    return toCountryRuleView(
      row,
      this.igaming?.blockedCountries.includes(row.countryCode) ?? false,
    );
  }

  private emitAccessRedirected(
    ipAddress: string | null,
    { countryCode, redirectUrl }: { countryCode: string; redirectUrl: string },
  ) {
    this.events.emit('compliance.geo.access_redirected', {
      countryCode,
      redirectUrl,
      ip: ipAddress,
    });
  }

  private emitAccessBlocked(
    ipAddress: string | null,
    { countryCode, reason }: { countryCode: string | null; reason: string },
  ) {
    this.events.emit('compliance.geo.access_blocked', { countryCode, reason, ip: ipAddress });
  }

  /**
   * The single country-rule decision every caller shares: registration, login, game
   * launch and any page-level gate a consumer builds on `GET /compliance/geo-check`.
   *
   * Fail-closed on an unresolved country whenever any block rule exists, so a lookup
   * outage cannot silently reopen a blacklisted jurisdiction. A denial is emitted here
   * rather than by each caller, so no enforcement point can be added without its audit
   * trail.
   *
   * `redirectUrl` rides along on an allowed decision: a redirected country passes here even
   * when blacklisted, because its players are meant to reach the platform through the mirror.
   * The decision only sees the address, so holding such a player to the mirror is the
   * consumer's job, with `redirectUrl` from `GEO_CHECK_COMMANDS.checkAccess`; letting a
   * blacklisted country in this way is audited as `compliance.geo.access_redirected`.
   */
  async geoCheck(ipAddress: string | null) {
    const { isBlacklistAdmittedByMirror, ...decision } = await this.decideCountryAccess(ipAddress);
    if (!decision.allowed) {
      this.emitAccessBlocked(ipAddress, decision);
    } else if (isBlacklistAdmittedByMirror && decision.countryCode && decision.redirectUrl) {
      this.emitAccessRedirected(ipAddress, {
        countryCode: decision.countryCode,
        redirectUrl: decision.redirectUrl,
      });
    }
    return decision;
  }

  /**
   * `GET /compliance/geo-check`: the same decision, but a consumer polls it on every page
   * load, so a denial is audited once per address and country per window - the first row
   * is the evidence, the rest would be noise. Best-effort: a cache outage audits every
   * poll rather than none.
   */
  async visitorGeoCheck(ipAddress: string | null) {
    const { isBlacklistAdmittedByMirror: _admittedByMirror, ...decision } =
      await this.decideCountryAccess(ipAddress);
    if (!decision.allowed && (await this.isFirstVisitorBlockInWindow(ipAddress, decision))) {
      this.emitAccessBlocked(ipAddress, decision);
    }
    return decision;
  }

  private async isFirstVisitorBlockInWindow(
    ipAddress: string | null,
    { countryCode }: { countryCode: string | null },
  ) {
    if (!this.cache) {
      return true;
    }
    try {
      return await this.cache.setIfAbsent(
        `geo-check-audit:${ipAddress ?? 'unknown'}:${countryCode ?? 'unresolved'}`,
        true,
        { ttlMs: VISITOR_GEO_BLOCK_AUDIT_WINDOW_MS },
      );
    } catch {
      return true;
    }
  }

  private async decideCountryAccess(ipAddress: string | null): Promise<
    | {
        allowed: true;
        countryCode: string | null;
        reason: null;
        redirectUrl: string | null;
        isBlacklistAdmittedByMirror: boolean;
      }
    | {
        allowed: false;
        countryCode: string | null;
        reason: string;
        redirectUrl: null;
        isBlacklistAdmittedByMirror: false;
      }
  > {
    const open = (countryCode: string | null) =>
      ({
        allowed: true,
        countryCode,
        reason: null,
        redirectUrl: null,
        isBlacklistAdmittedByMirror: false,
      }) as const;

    if (!this.geoIp) {
      return open(null);
    }

    const countryCode = normalizeCountryCode(
      ipAddress ? (await this.geoIp.lookup(ipAddress)).countryCode : null,
    );

    // Counts a redirected blacklisted country too, deliberately: without a country there is
    // no mirror to send the visitor to, so an unresolved address stays denied.
    if (!countryCode) {
      const [blacklistedRule] = await this.drizzle.db
        .select({ countryCode: countryRule.countryCode })
        .from(countryRule)
        .where(eq(countryRule.action, 'block'))
        .limit(1);
      return blacklistedRule || this.igaming?.blockedCountries.length
        ? {
            allowed: false,
            countryCode: null,
            reason: 'Geolocation could not be determined',
            redirectUrl: null,
            isBlacklistAdmittedByMirror: false,
          }
        : open(null);
    }

    const blocked = {
      allowed: false,
      countryCode,
      reason: `Country ${countryCode} is blocked`,
      redirectUrl: null,
      isBlacklistAdmittedByMirror: false,
    } as const;

    // Deployment-level blocks are not the operator's to redirect around.
    if (this.igaming?.blockedCountries.includes(countryCode)) {
      return blocked;
    }

    const [rule] = await this.drizzle.db
      .select({
        action: countryRule.action,
        redirectIp: countryRule.redirectIp,
        mirrorUrl: countryRule.mirrorUrl,
      })
      .from(countryRule)
      .where(eq(countryRule.countryCode, countryCode));

    if (!rule) {
      return open(countryCode);
    }
    const settings = { ...rule, blacklisted: rule.action === 'block' };
    if (deniesAccess(settings)) {
      return blocked;
    }

    return {
      ...open(countryCode),
      redirectUrl: mirrorTargetOf(rule),
      isBlacklistAdmittedByMirror: settings.blacklisted,
    };
  }

  async checkGame(input: GameGeoCheckInput) {
    const globalDecision = await this.geoCheck(input.ipAddress);
    if (!globalDecision.allowed) {
      return {
        allowed: false as const,
        countryCode: globalDecision.countryCode,
        reason: globalDecision.countryCode
          ? ('global_block' as const)
          : ('geo_unresolved' as const),
      };
    }

    const { countryCode } = globalDecision;
    const matchesCountry = (
      column: typeof providerGeoRule.countryCode | typeof gameGeoRule.countryCode,
    ) => (countryCode ? eq(column, countryCode) : undefined);
    const [rules] = await this.drizzle.db
      .select({
        providerRule: sql<boolean>`${exists(
          this.drizzle.db
            .select({ id: providerGeoRule.id })
            .from(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, game.providerId),
                matchesCountry(providerGeoRule.countryCode),
              ),
            ),
        )}`,
        gameRule: sql<boolean>`${exists(
          this.drizzle.db
            .select({ id: gameGeoRule.id })
            .from(gameGeoRule)
            .where(and(eq(gameGeoRule.gameId, game.id), matchesCountry(gameGeoRule.countryCode))),
        )}`,
      })
      .from(game)
      .where(eq(game.id, input.gameId));

    if (!rules) {
      return { allowed: false as const, countryCode: null, reason: 'game_not_found' as const };
    }
    if (!countryCode) {
      return rules.providerRule || rules.gameRule
        ? { allowed: false as const, countryCode: null, reason: 'geo_unresolved' as const }
        : { allowed: true as const, countryCode: null, reason: null };
    }
    if (rules.providerRule) {
      return { allowed: false as const, countryCode, reason: 'provider_block' as const };
    }
    if (rules.gameRule) {
      return { allowed: false as const, countryCode, reason: 'game_block' as const };
    }

    return { allowed: true as const, countryCode, reason: null };
  }

  async checkAccess(ipAddress: string | null) {
    const result = await this.geoCheck(ipAddress);
    return {
      allowed: result.allowed,
      countryCode: result.countryCode,
      redirectUrl: result.redirectUrl,
    };
  }

  async listGloballyBlockedCountries(): Promise<string[]> {
    const rows = await this.drizzle.db
      .select({ countryCode: countryRule.countryCode })
      .from(countryRule)
      .where(countryRuleDeniesAccess);
    const blocked = new Set([
      ...(this.igaming?.blockedCountries ?? []),
      ...rows.map((row) => row.countryCode),
    ]);
    return [...blocked].sort();
  }

  async upsertCountryRule(input: UpsertCountryRuleInput, actorId: User['id'], meta?: ClientMeta) {
    return this.drizzle.db.transaction(async (tx) => {
      if (input.blacklisted && this.igaming?.jurisdictions.includes(input.countryCode)) {
        throw new LicensedJurisdictionBlacklistError();
      }

      const [inserted] = await tx
        .insert(countryRule)
        .values({ countryCode: input.countryCode, action: 'allow' })
        .onConflictDoNothing()
        .returning();
      const before =
        inserted ??
        findOneOrThrow(
          await tx
            .select()
            .from(countryRule)
            .where(eq(countryRule.countryCode, input.countryCode))
            .for('update'),
          new CountryRuleNotFoundError(input.countryCode),
        );

      if (!hasExpectedVersion(before.updatedAt, input.expectedUpdatedAt)) {
        throw new CountryRuleVersionConflictError();
      }
      const next: CountryRuleSettings = {
        blacklisted: input.blacklisted,
        redirectIp: input.redirectIp,
        kycRequired: input.kycRequired,
        mirrorUrl: input.mirrorUrl === undefined ? before.mirrorUrl : input.mirrorUrl,
      };
      if (needsConfirmation(before, next) && !input.confirm) {
        throw new CountryRuleConfirmationRequiredError();
      }
      const nextTarget = mirrorTargetOf(next);
      if (
        nextTarget !== null &&
        this.mirrorTargetPolicy &&
        !(await this.mirrorTargetPolicy.isApprovedTarget(tx, nextTarget))
      ) {
        throw new MirrorTargetNotApprovedError();
      }
      if (!hasCountryRuleChanges(before, next)) {
        if (inserted) {
          const row = findOneOrThrow(
            await tx
              .update(countryRule)
              .set({ updatedAt: new Date(), updatedBy: actorId })
              .where(eq(countryRule.id, before.id))
              .returning(),
            new CountryRuleNotFoundError(input.countryCode),
          );
          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'admin',
            action: 'compliance.country_rule.created',
            resourceType: 'country-rule',
            resourceId: input.countryCode,
            before: null,
            after: {
              blacklisted: false,
              redirectIp: false,
              mirrorUrl: null,
              kycRequired: true,
            },
            ...meta,
          });
          return this.countryRuleView(row);
        }
        return this.countryRuleView(before);
      }

      const row = findOneOrThrow(
        await tx
          .update(countryRule)
          .set({
            action: input.blacklisted ? 'block' : 'allow',
            redirectIp: input.redirectIp,
            mirrorUrl: next.mirrorUrl,
            kycRequired: input.kycRequired,
            updatedAt: new Date(),
            updatedBy: actorId,
          })
          .where(eq(countryRule.id, before.id))
          .returning(),
        new CountryRuleNotFoundError(input.countryCode),
      );

      for (const field of COUNTRY_RULE_FIELDS) {
        if (countryRuleFieldValue(before, field) === countryRuleFieldValue(row, field)) {
          continue;
        }
        await this.audit.recordInTransaction(tx, {
          actorId,
          actorType: 'admin',
          action: 'compliance.country_rule.setting_changed',
          resourceType: 'country-rule',
          resourceId: input.countryCode,
          before: { setting: field, value: countryRuleFieldValue(before, field) },
          after: { setting: field, value: countryRuleFieldValue(row, field) },
          ...meta,
        });
      }

      return this.countryRuleView(row);
    });
  }

  async listCountryRules() {
    const rows = await this.drizzle.db.select().from(countryRule);
    return rows.map((row) => this.countryRuleView(row));
  }

  async getGlobalKycConfig() {
    const [row] = await this.drizzle.db
      .select()
      .from(globalKycConfig)
      .where(eq(globalKycConfig.singletonKey, 'global'));
    return row
      ? toGlobalKycConfigView(row)
      : {
          enabled: GLOBAL_KYC_ENABLED_DEFAULT,
          withdrawalThreshold: null,
          cumulativeDepositThreshold: GLOBAL_KYC_CUMULATIVE_DEPOSIT_THRESHOLD_DEFAULT,
          updatedAt: null,
          updatedBy: null,
        };
  }

  /**
   * The effective KYC requirement for a player, combining the global switch with the
   * per-country exemption list. Fail-closed on every "we don't actually know" branch:
   * an unresolved country is treated as requiring KYC, and a country with no rule row
   * defaults to `kycRequired: true` (the same default `countryRule.kycRequired` carries
   * in the schema).
   */
  async resolveKycRequirement(countryCode: string | null): Promise<{
    required: boolean;
    reason: 'global_disabled' | 'country_exempt' | 'required' | 'country_unknown';
  }> {
    const global = await this.getGlobalKycConfig();
    if (!global.enabled) {
      return { required: false, reason: 'global_disabled' };
    }

    const normalized = normalizeCountryCode(countryCode);
    if (!normalized) {
      return { required: true, reason: 'country_unknown' };
    }

    const [rule] = await this.drizzle.db
      .select({ kycRequired: countryRule.kycRequired })
      .from(countryRule)
      .where(eq(countryRule.countryCode, normalized));

    if (rule && !rule.kycRequired) {
      return { required: false, reason: 'country_exempt' };
    }
    return { required: true, reason: 'required' };
  }

  async setGlobalKycConfig(input: SetGlobalKycConfigInput, actorId: User['id'], meta?: ClientMeta) {
    return this.drizzle.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(globalKycConfig)
        .values({ singletonKey: 'global' })
        .onConflictDoNothing()
        .returning();
      const before =
        inserted ??
        findOneOrThrow(
          await tx
            .select()
            .from(globalKycConfig)
            .where(eq(globalKycConfig.singletonKey, 'global'))
            .for('update'),
          new GlobalKycConfigNotFoundError('global'),
        );

      if (!hasExpectedVersion(before.updatedAt, input.expectedUpdatedAt)) {
        throw new GlobalKycConfigVersionConflictError();
      }
      const next = {
        enabled: input.enabled,
        withdrawalThreshold:
          input.withdrawalThreshold === undefined
            ? before.withdrawalThreshold
            : input.withdrawalThreshold,
        cumulativeDepositThreshold:
          input.cumulativeDepositThreshold ?? before.cumulativeDepositThreshold,
      };
      if (
        before.enabled === next.enabled &&
        moneyEqualsOrBothNull(before.withdrawalThreshold, next.withdrawalThreshold) &&
        moneyEquals(before.cumulativeDepositThreshold, next.cumulativeDepositThreshold)
      ) {
        return toGlobalKycConfigView(before);
      }

      const row = findOneOrThrow(
        await tx
          .update(globalKycConfig)
          .set({ ...next, updatedAt: new Date(), updatedBy: actorId })
          .where(eq(globalKycConfig.id, before.id))
          .returning(),
        new GlobalKycConfigNotFoundError('global'),
      );

      await this.audit.recordInTransaction(tx, {
        actorId,
        actorType: 'admin',
        action: 'compliance.global_kyc.set',
        resourceType: 'global-kyc-config',
        resourceId: 'global',
        before: {
          enabled: before.enabled,
          withdrawalThreshold: before.withdrawalThreshold,
          cumulativeDepositThreshold: before.cumulativeDepositThreshold,
        },
        after: {
          enabled: row.enabled,
          withdrawalThreshold: row.withdrawalThreshold,
          cumulativeDepositThreshold: row.cumulativeDepositThreshold,
        },
        ...meta,
      });

      return toGlobalKycConfigView(row);
    });
  }

  async addGeoRule(input: AddGeoRuleInput, actorId: User['id'], meta?: ClientMeta) {
    const [existing] = await this.drizzle.db
      .select()
      .from(countryRule)
      .where(eq(countryRule.countryCode, input.countryCode));
    const blacklisted = input.action === 'block';
    const rule = await this.upsertCountryRule(
      {
        countryCode: input.countryCode,
        blacklisted,
        redirectIp: existing?.redirectIp ?? false,
        // Blocking through this route means blocked: a stored mirror would otherwise keep
        // the country open while the rule and its event both say `block`.
        ...(blacklisted ? { mirrorUrl: null } : {}),
        kycRequired: existing?.kycRequired ?? true,
        expectedUpdatedAt: existing?.updatedAt?.toISOString() ?? null,
        confirm: input.confirm ?? true,
      },
      actorId,
      meta,
    );

    if ((existing?.action === 'block') !== blacklisted) {
      this.events.emit('compliance.geo-rule.added', {
        countryCode: input.countryCode,
        action: input.action,
        actorId,
        ip: meta?.ip ?? null,
        userAgent: meta?.userAgent ?? null,
      });
    }
    return {
      id: rule.id,
      countryCode: rule.countryCode,
      action: (rule.blacklisted ? 'block' : 'allow') as GeoRuleAction,
      createdAt: rule.createdAt,
    };
  }

  async listGeoRules() {
    const rows = await this.drizzle.db.select().from(countryRule);
    return rows.map(toGeoRuleView);
  }

  async upsertGameGeoRules(input: UpsertGameGeoRulesInput, actorId: User['id'], meta: ClientMeta) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const changes = await this.drizzle.db.transaction(async (tx) => {
      findOneOrThrow(
        await tx.select({ id: game.id }).from(game).where(eq(game.id, input.gameId)),
        new GeoRuleGameNotFoundError(input.gameId),
      );

      return withGameGeoRuleLocks(tx, input.gameId, countryCodes, async () => {
        const before = await tx
          .select()
          .from(gameGeoRule)
          .where(
            and(
              eq(gameGeoRule.gameId, input.gameId),
              inArray(gameGeoRule.countryCode, countryCodes),
            ),
          );
        const rows = await tx
          .insert(gameGeoRule)
          .values(
            countryCodes.map((countryCode) => ({
              gameId: input.gameId,
              countryCode,
              reason: input.reason,
            })),
          )
          .onConflictDoUpdate({
            target: [gameGeoRule.gameId, gameGeoRule.countryCode],
            set: { reason: input.reason, updatedAt: new Date() },
          })
          .returning();
        return pairGeoRuleChanges(before, rows);
      });
    });

    for (const { before, after } of changes) {
      this.events.emit('compliance.game-geo-rule.upserted', {
        ruleId: after.id,
        gameId: input.gameId,
        countryCode: after.countryCode,
        reason: input.reason,
        before,
        after,
        actorId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return changes.map(({ after }) => after);
  }

  async deleteGameGeoRules(input: DeleteGameGeoRulesInput, actorId: User['id'], meta: ClientMeta) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const deleted = await this.drizzle.db.transaction((tx) =>
      withGameGeoRuleLocks(tx, input.gameId, countryCodes, async () => {
        const rows = await tx
          .delete(gameGeoRule)
          .where(
            and(
              eq(gameGeoRule.gameId, input.gameId),
              inArray(gameGeoRule.countryCode, countryCodes),
            ),
          )
          .returning();
        const missing = missingCountryCodes(countryCodes, rows);
        if (missing.length > 0) {
          throw new GameGeoRuleNotFoundError(`${input.gameId}:${missing.join(',')}`);
        }
        return rows
          .map(serializeGeoRule)
          .sort((a, b) => a.countryCode.localeCompare(b.countryCode));
      }),
    );

    for (const before of deleted) {
      this.events.emit('compliance.game-geo-rule.deleted', {
        ruleId: before.id,
        gameId: before.gameId,
        countryCode: before.countryCode,
        reason: input.reason,
        before,
        after: null,
        actorId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return deleted;
  }

  /**
   * Idempotent: a game that already has the rule keeps it, reason included, and counts as
   * `unchanged`. Never writes `provider_geo_rule`.
   */
  async bulkRestrictGameGeoRules(
    input: BulkGameGeoRuleInput,
    actorId: User['id'],
    meta: ClientMeta,
  ): Promise<BulkRestrictGameGeoRulesOutput> {
    const outcome = await this.bulkWriteGameGeoRules(
      'restrict',
      input,
      actorId,
      meta,
      async (tx, games) => {
        if (games.length === 0) {
          return { rules: [] };
        }
        const rows = await tx
          .insert(gameGeoRule)
          .values(
            games.map((row) => ({
              gameId: row.id,
              countryCode: input.countryCode,
              reason: input.reason,
            })),
          )
          .onConflictDoNothing({ target: [gameGeoRule.gameId, gameGeoRule.countryCode] })
          .returning();
        return { rules: serializeBulkGeoRules(rows) };
      },
    );

    return {
      changed: outcome.rules.length,
      unchanged: outcome.matchedCount - outcome.rules.length,
      notFound: outcome.notFound,
    };
  }

  /**
   * Idempotent: a game without the rule counts as `unchanged`, not NOT_FOUND. Never deletes
   * `provider_geo_rule`; games it keeps blocked are counted in `stillBlockedByProvider`.
   */
  async bulkUnrestrictGameGeoRules(
    input: BulkGameGeoRuleInput,
    actorId: User['id'],
    meta: ClientMeta,
  ): Promise<BulkUnrestrictGameGeoRulesOutput> {
    const outcome = await this.bulkWriteGameGeoRules(
      'unrestrict',
      input,
      actorId,
      meta,
      async (tx, games) => {
        if (games.length === 0) {
          return { rules: [], stillBlockedByProvider: 0 };
        }
        const rows = await tx
          .delete(gameGeoRule)
          .where(
            and(
              inArray(
                gameGeoRule.gameId,
                games.map((row) => row.id),
              ),
              eq(gameGeoRule.countryCode, input.countryCode),
            ),
          )
          .returning();

        const blockingProviders = await tx
          .select({ providerId: providerGeoRule.providerId })
          .from(providerGeoRule)
          .where(
            and(
              inArray(providerGeoRule.providerId, [...new Set(games.map((row) => row.providerId))]),
              eq(providerGeoRule.countryCode, input.countryCode),
            ),
          );
        const blockingProviderIds = new Set(blockingProviders.map((row) => row.providerId));

        return {
          rules: serializeBulkGeoRules(rows),
          stillBlockedByProvider: games.filter((row) => blockingProviderIds.has(row.providerId))
            .length,
        };
      },
    );

    const globallyBlocked = (await this.listGloballyBlockedCountries()).includes(input.countryCode);

    return {
      changed: outcome.rules.length,
      unchanged: outcome.matchedCount - outcome.rules.length,
      stillBlockedByProvider: outcome.stillBlockedByProvider,
      globallyBlocked,
      notFound: outcome.notFound,
    };
  }

  private async bulkWriteGameGeoRules<
    T extends { rules: ReturnType<typeof serializeBulkGeoRules> },
  >(
    operation: 'restrict' | 'unrestrict',
    input: BulkGameGeoRuleInput,
    actorId: User['id'],
    meta: ClientMeta,
    write: (tx: DrizzleTx, games: { id: string; providerId: string }[]) => Promise<T>,
  ) {
    const gameIds = [...new Set(input.gameIds ?? [])].sort();
    const providerIds = [...new Set(input.providerIds ?? [])].sort();

    const outcome = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, gameGeoRuleCountryLockKey(input.countryCode), async () => {
        const { games, notFoundGameIds, notFoundProviderIds } = await resolveBulkGeoScope(
          tx,
          gameIds,
          providerIds,
          GAME_BULK_CAP + 1,
        );
        await assertWithinGeoCap(tx, gameIds, providerIds, games.length);
        const result = await write(tx, games);
        const notFound = { gameIds: notFoundGameIds, providerIds: notFoundProviderIds };
        if (result.rules.length > 0) {
          await this.audit.recordInTransaction(tx, {
            actorId,
            actorType: 'admin',
            action: 'compliance.game-geo-rules.bulk_updated',
            resourceType: 'game-geo-rule',
            resourceId: null,
            // Unrestrict keeps what it deleted, so the licence history survives the removal.
            before:
              operation === 'unrestrict'
                ? {
                    removedRules: result.rules.map(({ id, gameId, reason }) => ({
                      ruleId: id,
                      gameId,
                      reason,
                    })),
                  }
                : null,
            after: {
              operation,
              countryCode: input.countryCode,
              reason: input.reason,
              changedGameIds: result.rules.map((rule) => rule.gameId),
              target: { gameIds, providerIds },
              notFound,
            },
            ...meta,
          });
        }
        return { ...result, matchedCount: games.length, notFound };
      }),
    );

    if (outcome.rules.length > 0) {
      this.events.emit('compliance.game-geo-rules.bulk_updated', {
        operation,
        countryCode: input.countryCode,
        reason: input.reason,
        changedGameIds: outcome.rules.map((rule) => rule.gameId),
        target: { gameIds, providerIds },
        notFound: outcome.notFound,
        actorId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return outcome;
  }

  async listGameGeoRules({ gameIds, page, limit }: ListGameGeoRulesInput) {
    const where = gameIds ? inArray(gameGeoRule.gameId, gameIds) : undefined;
    const db = this.drizzle.db;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(gameGeoRule)
        .where(where)
        .orderBy(asc(gameGeoRule.gameId), asc(gameGeoRule.countryCode))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(gameGeoRule).where(where),
    ]);
    return { items: rows.map(serializeGeoRule), total: Number(n), page, limit };
  }

  async upsertProviderGeoRules(
    input: UpsertProviderGeoRulesInput,
    actorId: User['id'],
    meta: ClientMeta,
  ) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const changes = await this.drizzle.db.transaction(async (tx) => {
      findOneOrThrow(
        await tx
          .select({ id: gameProvider.id })
          .from(gameProvider)
          .where(eq(gameProvider.id, input.providerId)),
        new GeoRuleProviderNotFoundError(input.providerId),
      );

      return withAdvisoryXactLocks(
        tx,
        countryCodes.map((countryCode) => providerGeoRuleLockKey(input.providerId, countryCode)),
        async () => {
          const before = await tx
            .select()
            .from(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, input.providerId),
                inArray(providerGeoRule.countryCode, countryCodes),
              ),
            );
          const rows = await tx
            .insert(providerGeoRule)
            .values(
              countryCodes.map((countryCode) => ({
                providerId: input.providerId,
                countryCode,
                reason: input.reason,
              })),
            )
            .onConflictDoUpdate({
              target: [providerGeoRule.providerId, providerGeoRule.countryCode],
              set: { reason: input.reason, updatedAt: new Date() },
            })
            .returning();
          return pairGeoRuleChanges(before, rows);
        },
      );
    });

    for (const { before, after } of changes) {
      this.events.emit('compliance.provider-geo-rule.upserted', {
        ruleId: after.id,
        providerId: input.providerId,
        countryCode: after.countryCode,
        reason: input.reason,
        before,
        after,
        actorId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return changes.map(({ after }) => after);
  }

  async deleteProviderGeoRules(
    input: DeleteProviderGeoRulesInput,
    actorId: User['id'],
    meta: ClientMeta,
  ) {
    const countryCodes = [...new Set(input.countryCodes)].sort();
    const deleted = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLocks(
        tx,
        countryCodes.map((countryCode) => providerGeoRuleLockKey(input.providerId, countryCode)),
        async () => {
          const rows = await tx
            .delete(providerGeoRule)
            .where(
              and(
                eq(providerGeoRule.providerId, input.providerId),
                inArray(providerGeoRule.countryCode, countryCodes),
              ),
            )
            .returning();
          const missing = missingCountryCodes(countryCodes, rows);
          if (missing.length > 0) {
            throw new ProviderGeoRuleNotFoundError(`${input.providerId}:${missing.join(',')}`);
          }
          return rows
            .map(serializeGeoRule)
            .sort((a, b) => a.countryCode.localeCompare(b.countryCode));
        },
      ),
    );

    for (const before of deleted) {
      this.events.emit('compliance.provider-geo-rule.deleted', {
        ruleId: before.id,
        providerId: before.providerId,
        countryCode: before.countryCode,
        reason: input.reason,
        before,
        after: null,
        actorId,
        ip: meta.ip,
        userAgent: meta.userAgent,
      });
    }
    return deleted;
  }

  async listProviderGeoRules({ providerIds, page, limit }: ListProviderGeoRulesInput) {
    const where = providerIds ? inArray(providerGeoRule.providerId, providerIds) : undefined;
    const db = this.drizzle.db;
    const [rows, [{ n }]] = await Promise.all([
      db
        .select()
        .from(providerGeoRule)
        .where(where)
        .orderBy(asc(providerGeoRule.providerId), asc(providerGeoRule.countryCode))
        .limit(limit)
        .offset(pageToOffset(page, limit)),
      db.select({ n: count() }).from(providerGeoRule).where(where),
    ]);
    return { items: rows.map(serializeGeoRule), total: Number(n), page, limit };
  }
}
