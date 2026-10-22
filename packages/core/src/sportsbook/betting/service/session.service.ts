import { and, asc, eq, gt, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  createDomainError,
  createLogger,
  findOneOrThrow,
  makeNotFoundError,
  mapConcurrent,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import type {
  AuditWritePort,
  GeoCheckCommands,
  PlayEligibilityPort,
  SportsbookProvider,
  SportsbookSessionArgs,
  SportsbookSessionOutcome,
  User,
  WalletReader,
} from '@openora/core/contracts';
import {
  SportsbookProviderSessionSchema,
  SportsbookSessionArgsSchema,
  UuidSchema,
} from '@openora/core/contracts';
import {
  SPORTSBOOK_RECONCILE_BATCH,
  type IssueSportsbookSessionInput,
  type SportsbookRgRevokeJob,
  type SportsbookSession,
} from '../contract/index.js';
import { sportsbookSession, type SportsbookSessionRow } from '../schema/index.js';
import type { SportsbookConfigService } from './config.service.js';
import { lockConfig, lockPlayer } from './locks.service.js';
import { isPlayerRestricted } from './restriction-check.service.js';

const logger = createLogger('sportsbook');

export const SportsbookUnavailableError = createDomainError<[]>(
  'SportsbookUnavailableError',
  () => 'Sportsbook is not available',
  { reason: 'unavailable' },
);
export const SportsbookCurrencyNotOfferedError = createDomainError<[currency: string]>(
  'SportsbookCurrencyNotOfferedError',
  (currency) => `Sportsbook does not offer ${currency}`,
  { reason: 'currency_not_offered' },
);
export const SportsbookGeoRestrictedError = createDomainError<[]>(
  'SportsbookGeoRestrictedError',
  () => 'Sportsbook is not available in your country',
  { reason: 'geo_restricted' },
);
export const SportsbookPlayerBlockedError = createDomainError<[]>(
  'SportsbookPlayerBlockedError',
  () => 'Sportsbook play is blocked for this account',
  { reason: 'player_blocked' },
);
export const SportsbookProviderUnavailableError = createDomainError<[]>(
  'SportsbookProviderUnavailableError',
  () => 'The sportsbook provider could not open a session',
  { reason: 'provider_unavailable' },
);
const SportsbookSessionNotFoundError = makeNotFoundError('SportsbookSession');

const MINUTE_MS = 60_000;
const PROVIDER_REVOKE_CONCURRENCY = 4;

/** A session a reserve may bet on: live, bound to this provider. */
export function isLiveSession(
  session: SportsbookSessionRow | undefined,
  provider: SportsbookSessionRow['provider'],
  now = new Date(),
): session is SportsbookSessionRow {
  return (
    session !== undefined &&
    session.provider === provider &&
    session.revokedAt === null &&
    session.expiresAt > now
  );
}

export type SportsbookSessionDeps = {
  drizzle: DrizzleService;
  audit: AuditWritePort;
  config: SportsbookConfigService;
  playEligibility: PlayEligibilityPort;
  walletReader: WalletReader;
  geoCheck?: GeoCheckCommands;
  provider?: SportsbookProvider;
};

export class SportsbookSessionService {
  private readonly drizzle: DrizzleService;
  private readonly audit: AuditWritePort;
  private readonly config: SportsbookConfigService;
  private readonly playEligibility: PlayEligibilityPort;
  private readonly walletReader: WalletReader;
  private readonly geoCheck: GeoCheckCommands | undefined;
  private readonly provider: SportsbookProvider | undefined;

  constructor(deps: SportsbookSessionDeps) {
    this.drizzle = deps.drizzle;
    this.audit = deps.audit;
    this.config = deps.config;
    this.playEligibility = deps.playEligibility;
    this.walletReader = deps.walletReader;
    this.geoCheck = deps.geoCheck;
    this.provider = deps.provider;
  }

  async issue(
    userId: User['id'],
    input: IssueSportsbookSessionInput,
    ipAddress: string | null,
  ): Promise<SportsbookSession> {
    const provider = this.provider;
    if (!provider || !this.geoCheck) {
      throw new SportsbookUnavailableError();
    }
    const currency = input.currency.toUpperCase();
    const offered = await this.config.get(this.drizzle.db);
    if (!offered.enabled || offered.suspended) {
      throw new SportsbookUnavailableError();
    }
    const geo = await this.geoCheck.checkAccess(ipAddress);
    const countryCode = geo.countryCode?.toUpperCase() ?? null;
    if (!geo.allowed || !countryCode) {
      throw new SportsbookGeoRestrictedError();
    }

    const session = await this.drizzle.db.transaction(async (tx) => {
      await lockConfig(tx, 'shared');
      await lockPlayer(tx, userId);
      const config = await this.config.get(tx);
      if (!config.enabled || config.suspended) {
        throw new SportsbookUnavailableError();
      }
      if (!config.currencies.some((c) => c.currency === currency)) {
        throw new SportsbookCurrencyNotOfferedError(currency);
      }
      if (config.blockedCountries.includes(countryCode)) {
        throw new SportsbookGeoRestrictedError();
      }
      if (
        (await isPlayerRestricted(tx, userId)) ||
        (await this.playEligibility.isRestricted(userId, tx))
      ) {
        throw new SportsbookPlayerBlockedError();
      }
      const rows = await tx
        .insert(sportsbookSession)
        .values({
          userId,
          provider: provider.name,
          currency,
          countryCode,
          expiresAt: new Date(Date.now() + config.sessionTtlMinutes * MINUTE_MS),
        })
        .returning();
      return findOneOrThrow(rows, new SportsbookSessionNotFoundError(userId));
    });

    const expiresAt = session.expiresAt.toISOString();
    let opened;
    try {
      opened = SportsbookProviderSessionSchema.parse(
        await provider.issueSession({
          sessionId: session.id,
          userId,
          currency,
          countryCode,
          expiresAt,
          ...(input.locale === undefined ? {} : { locale: input.locale }),
        }),
      );
    } catch (err) {
      logger.warn({ err, sessionId: session.id }, 'sportsbook: provider refused to open a session');
      try {
        await this.drizzle.db
          .update(sportsbookSession)
          .set({ revokedAt: sql`coalesce(${sportsbookSession.revokedAt}, now())` })
          .where(eq(sportsbookSession.id, session.id));
        await this.revokeAtProvider(userId, [session.id]);
      } catch (revokeErr) {
        logger.warn(
          { err: revokeErr, sessionId: session.id },
          'sportsbook: revoking a session the provider refused failed',
        );
      }
      throw new SportsbookProviderUnavailableError();
    }
    const [current] = await this.drizzle.db
      .update(sportsbookSession)
      .set({ providerOpenedAt: sql`now()` })
      .where(eq(sportsbookSession.id, session.id))
      .returning({ revokedAt: sportsbookSession.revokedAt });
    if (current?.revokedAt !== null) {
      await this.revokeAtProvider(userId, [session.id]);
      throw new SportsbookProviderUnavailableError();
    }
    return {
      sessionId: session.id,
      token: opened.token,
      launchUrl: opened.launchUrl ?? null,
      currency,
      expiresAt,
    };
  }

  /** The provider's authenticate and balance callbacks. Reads only; reserve re-checks under its locks. */
  async describe(args: SportsbookSessionArgs): Promise<SportsbookSessionOutcome> {
    const parsed = SportsbookSessionArgsSchema.safeParse(args);
    const sessionId = UuidSchema.safeParse(args.sessionId);
    if (!parsed.success || !sessionId.success) {
      return { status: 'refused', reason: 'session_invalid' };
    }
    const { provider } = parsed.data;
    const [session] = await this.drizzle.db
      .select()
      .from(sportsbookSession)
      .where(eq(sportsbookSession.id, sessionId.data));
    if (
      !isLiveSession(session, provider) ||
      (await isPlayerRestricted(this.drizzle.db, session.userId)) ||
      (await this.playEligibility.isRestricted(session.userId))
    ) {
      return { status: 'refused', reason: 'session_invalid' };
    }
    const { balances } = await this.walletReader.getBalances(session.userId);
    return {
      status: 'ok',
      userId: session.userId,
      currency: session.currency,
      countryCode: session.countryCode,
      expiresAt: session.expiresAt.toISOString(),
      balance: balances.find((b) => b.currency === session.currency)?.balance ?? '0',
    };
  }

  /** Runs under the caller's player lock; hand the result to `revokeAtProvider` after commit. */
  async revokeLive(tx: DrizzleTx, userId: User['id']): Promise<SportsbookSessionRow['id'][]> {
    const rows = await tx
      .update(sportsbookSession)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(sportsbookSession.userId, userId),
          isNull(sportsbookSession.revokedAt),
          gt(sportsbookSession.expiresAt, new Date()),
        ),
      )
      .returning({ id: sportsbookSession.id });
    return rows.map((r) => r.id);
  }

  /**
   * An RG restriction started: kill the player's live sessions and audit it, then tell the provider
   * about every revoked session it opened and has not acknowledged. Throws while one is left, so the
   * job retries; the reconcile sweep covers a session whose open core never recorded.
   */
  async revokeAll(
    userId: User['id'],
    trigger: SportsbookRgRevokeJob['trigger'] | 'reconcile',
  ): Promise<void> {
    await this.drizzle.db.transaction(async (tx) => {
      await lockPlayer(tx, userId);
      const ids = await this.revokeLive(tx, userId);
      if (ids.length > 0) {
        await this.audit.recordInTransaction(tx, {
          actorId: null,
          actorType: 'system',
          action: 'sportsbook.sessions.revoked',
          resourceType: 'sportsbook_session',
          resourceId: userId,
          after: { revokedSessions: ids, trigger },
        });
      }
    });
    const provider = this.provider;
    if (!provider?.revokeSession) {
      return;
    }
    const unacknowledged = await this.drizzle.db
      .select({ id: sportsbookSession.id })
      .from(sportsbookSession)
      .where(
        and(
          eq(sportsbookSession.userId, userId),
          eq(sportsbookSession.provider, provider.name),
          isNotNull(sportsbookSession.revokedAt),
          isNotNull(sportsbookSession.providerOpenedAt),
          isNull(sportsbookSession.providerRevokedAt),
          gt(sportsbookSession.expiresAt, new Date()),
        ),
      );
    const failed = await this.revokeAtProvider(
      userId,
      unacknowledged.map((r) => r.id),
    );
    if (failed.length > 0) {
      throw new Error(`sportsbook: the provider did not revoke ${failed.length} session(s)`);
    }
  }

  /**
   * Tells the provider after commit and marks each session it acknowledged. Returns the ones it did
   * not; the session is already dead in core, so a reserve on it refuses either way.
   */
  async revokeAtProvider(
    userId: User['id'],
    sessionIds: SportsbookSessionRow['id'][],
  ): Promise<SportsbookSessionRow['id'][]> {
    const failed = await mapConcurrent(
      sessionIds,
      PROVIDER_REVOKE_CONCURRENCY,
      async (sessionId) => ((await this.revokeOne(userId, sessionId)) ? null : sessionId),
    );
    return failed.filter((id) => id !== null);
  }

  /** Revokes the live sessions of every player play eligibility refuses, should an RG revoke not have run. */
  async revokeIneligible(now = new Date()): Promise<number> {
    let revoked = 0;
    let after: User['id'] | undefined;
    for (;;) {
      const page = await this.drizzle.db
        .selectDistinct({ userId: sportsbookSession.userId })
        .from(sportsbookSession)
        .where(
          and(
            isNull(sportsbookSession.revokedAt),
            gt(sportsbookSession.expiresAt, now),
            after ? gt(sportsbookSession.userId, after) : undefined,
          ),
        )
        .orderBy(asc(sportsbookSession.userId))
        .limit(SPORTSBOOK_RECONCILE_BATCH);
      await mapConcurrent(page, PROVIDER_REVOKE_CONCURRENCY, async ({ userId }) => {
        if (!(await this.playEligibility.isRestricted(userId))) {
          return;
        }
        revoked += 1;
        await this.revokeAll(userId, 'reconcile').catch((err: unknown) =>
          logger.warn({ err, userId }, 'sportsbook: revoke of an ineligible player failed'),
        );
      });
      if (page.length < SPORTSBOOK_RECONCILE_BATCH) {
        return revoked;
      }
      after = page.at(-1)?.userId;
    }
  }

  /** The reconcile job's retry of revoked sessions the provider has not acknowledged yet. */
  async retryProviderRevokes(): Promise<number> {
    const provider = this.provider;
    if (!provider?.revokeSession) {
      return 0;
    }
    const pending = await this.drizzle.db
      .select({ id: sportsbookSession.id, userId: sportsbookSession.userId })
      .from(sportsbookSession)
      .where(
        and(
          eq(sportsbookSession.provider, provider.name),
          isNotNull(sportsbookSession.revokedAt),
          isNull(sportsbookSession.providerRevokedAt),
          gt(sportsbookSession.expiresAt, new Date()),
        ),
      )
      .orderBy(
        sql`${sportsbookSession.providerRevokeAttemptedAt} ASC NULLS FIRST`,
        asc(sportsbookSession.expiresAt),
        asc(sportsbookSession.id),
      )
      .limit(SPORTSBOOK_RECONCILE_BATCH);
    await mapConcurrent(pending, PROVIDER_REVOKE_CONCURRENCY, (row) =>
      this.revokeOne(row.userId, row.id),
    );
    return pending.length;
  }

  private async revokeOne(userId: User['id'], sessionId: SportsbookSessionRow['id']) {
    const revoke = this.provider?.revokeSession?.bind(this.provider);
    if (!revoke) {
      return true;
    }
    // Read before the call: only a revoke sent after the provider's open was recorded can end it.
    const [session] = await this.drizzle.db
      .select({ openedAt: sportsbookSession.providerOpenedAt })
      .from(sportsbookSession)
      .where(eq(sportsbookSession.id, sessionId));
    let sent = true;
    try {
      await revoke({ sessionId, userId });
    } catch (err) {
      logger.warn({ err, sessionId }, 'sportsbook: provider session revoke failed');
      sent = false;
    }
    const acknowledged = sent && Boolean(session?.openedAt);
    await this.drizzle.db
      .update(sportsbookSession)
      .set({
        providerRevokeAttemptedAt: sql`now()`,
        ...(acknowledged ? { providerRevokedAt: sql`now()` } : {}),
      })
      .where(eq(sportsbookSession.id, sessionId));
    return acknowledged;
  }
}
