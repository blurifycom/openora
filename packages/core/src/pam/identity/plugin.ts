import {
  ACCOUNT_READER,
  ADMIN_SECURITY_POLICY,
  AUDIT_WRITER,
  ADMIN_USER_DIRECTORY,
  CACHE,
  GEO_IP_ADAPTER,
  IDENTITY_READER,
  KYC_ADAPTER,
  LOGIN_ENFORCEMENT,
  PLAY_ELIGIBILITY,
  PLAY_ELIGIBILITY_PROJECTION,
  PLAY_ELIGIBILITY_SOURCE,
  MAIL_DISPATCH,
  MAIL_RECIPIENT_DIRECTORY,
  MCP_TOKEN_REVOCATION,
  FRESH_REAUTHENTICATION,
  GEO_CHECK_COMMANDS,
  PLAYER_PROVISIONING,
  IDENTITY_OPTIONS,
  RATE_LIMITER,
  PLATFORM_CONFIG,
  SESSION_COMMANDS,
  SESSION_IDLE_POLICY,
  TWO_FACTOR_SETUP_POLICY,
  WITHDRAWAL_SECURITY,
  USER_COMMANDS,
  SMS_ADAPTER,
  REALTIME_TRANSPORT,
  AdminSecurityConfigSchema,
  domainEventSchemas,
  type RealtimeTransport,
  JOB_QUEUE,
  queue,
} from '@openora/core/contracts';
import {
  ADMIN_GUARD,
  EVENT_BUS,
  DRIZZLE,
  AUTH_SESSION,
  LOCAL_SESSION_RESOLVER,
  createLogger,
  retryUntilDone,
  projectionHeartbeatArmed,
  projectionHeartbeatEveryMs,
  parseInternalCallers,
} from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import * as z from 'zod';
import { DrizzleUserCommands } from './service/user-commands.service.js';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { MockSmsAdapter } from './adapters/mock/mock-sms-adapter.js';
import { TwoFactorDeliveryService } from './service/two-factor-delivery.service.js';
import { PhoneLoginService } from './service/phone-login.service.js';
import { PhoneVerificationService } from './service/phone-verification.service.js';
import { WithdrawalPinService } from './service/withdrawal-pin.service.js';
import { MIN_WITHDRAWAL_PIN_SECRET_LENGTH } from './service/withdrawal-pin-hash.service.js';
import {
  DrizzleAdminUserDirectory,
  DrizzleMailRecipientDirectory,
} from './admin-user-directory.js';
import { IdentityReaderService } from './adapters/identity-reader.service.js';
import { DrizzleAccountReader } from './adapters/account-reader.service.js';
import { createInternalAccountsRouter } from './router/internal-accounts.router.js';
import { createInternalSessionRouter } from './router/internal-sessions.router.js';
import {
  createIdentityRouter,
  sessionEventsChannel,
  type SessionEventsPush,
} from './router/index.js';
import { IdentityService } from './service/identity.service.js';
import { SessionService } from './service/session.service.js';
import { AdminSecurityService } from './service/admin-security.service.js';
import { TrustedDeviceService } from './service/trusted-device.service.js';
import { SessionIdleService } from './service/session-idle.service.js';
import { TwoFactorLockoutService } from './service/two-factor-lockout.service.js';
import { FreshReauthenticationService } from './service/fresh-reauthentication.service.js';
import { LoginEnforcementService } from './service/login-enforcement.service.js';
import {
  backfillPlayEligibility,
  playEligibilityOf,
  playEligibilityPage,
  PlayEligibilityPublisher,
  PlayEligibilityService,
} from './service/play-eligibility.service.js';
import { TwoFactorSetupPolicyService } from './service/two-factor-setup-policy.service.js';

type IdentityContainer = TypedContainer<CoreTokenCatalog>;

const PLAY_ELIGIBILITY_HEARTBEAT_QUEUE = queue('identity-ledger-heartbeat');
const logger = createLogger('identity');

function reportUnsafeAuthSurface(message: string): void {
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error(message);
  }
  logger.warn(message);
}

function assertAuthSurfaceGuards(c: IdentityContainer): void {
  if (!c.has(GEO_CHECK_COMMANDS)) {
    reportUnsafeAuthSurface(
      'identity mounts its sign-in, phone-login and 2FA routes but GEO_CHECK_COMMANDS is unbound, so the country gate is a silent no-op on registration and sign-in and writes no access-blocked audit row. Load the compliance module in this process, or load identity service-only (SERVICE_MANIFEST=audit:no-routes,identity:no-routes) so it serves no auth route.',
    );
  }
}

function adminSecurityConfig(c: IdentityContainer) {
  const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
  return platformConfig?.adminSecurity ?? AdminSecurityConfigSchema.parse({});
}

function mcpTokenRevocation(c: IdentityContainer) {
  return c.has(MCP_TOKEN_REVOCATION) ? c.get(MCP_TOKEN_REVOCATION) : undefined;
}

function makeSessionService(c: IdentityContainer) {
  return new SessionService({
    drizzle: c.get(DRIZZLE),
    events: c.get(EVENT_BUS),
    identityReader: c.get(IDENTITY_READER),
    mcpTokens: mcpTokenRevocation(c),
  });
}

function makePlayEligibilityPublisher(c: IdentityContainer) {
  return new PlayEligibilityPublisher(c.get(DRIZZLE), c.get(EVENT_BUS), () =>
    c.has(PLAY_ELIGIBILITY_PROJECTION) ? c.get(PLAY_ELIGIBILITY_PROJECTION) : undefined,
  );
}

function backfillPlayEligibilityAtBoot(c: IdentityContainer) {
  if (!c.has(PLAY_ELIGIBILITY_PROJECTION)) {
    return;
  }
  const projection = c.get(PLAY_ELIGIBILITY_PROJECTION);
  const db = c.get(DRIZZLE).db;
  const abort = new AbortController();
  c.onDispose(() => abort.abort());
  void retryUntilDone(() => backfillPlayEligibility(db, projection, { signal: abort.signal }), {
    signal: abort.signal,
    onFailure: (err, retryInMs) =>
      logger.error({ err, retryInMs }, 'identity: play eligibility boot backfill failed, retrying'),
  }).then((written) => {
    if (written) {
      logger.info({ written }, 'identity: play eligibility backfilled into the ledger at boot');
    }
  });
}

function makeTrustedDevices(c: IdentityContainer) {
  return new TrustedDeviceService({
    drizzle: c.get(DRIZZLE),
    events: c.get(EVENT_BUS),
    identityReader: c.get(IDENTITY_READER),
    trustedDeviceDays: adminSecurityConfig(c).trustedDeviceDays,
  });
}

function makeTwoFactorLockout(c: IdentityContainer) {
  return new TwoFactorLockoutService({
    drizzle: c.get(DRIZZLE),
    events: c.get(EVENT_BUS),
    identityReader: c.get(IDENTITY_READER),
    config: adminSecurityConfig(c).twoFactorLockout,
  });
}

function makeWithdrawalPin(c: IdentityContainer, hmacSecret: string) {
  return new WithdrawalPinService({
    drizzle: c.get(DRIZZLE),
    events: c.get(EVENT_BUS),
    limiter: c.get(RATE_LIMITER),
    auth: c.get(AUTH_SESSION).auth,
    identityReader: c.get(IDENTITY_READER),
    twoFactorLockout: makeTwoFactorLockout(c),
    mailDispatch: c.get(MAIL_DISPATCH),
    hmacSecret,
    trustedDeviceDays: adminSecurityConfig(c).trustedDeviceDays,
  });
}

function makeAdminSecurity(c: IdentityContainer) {
  const identityReader = c.get(IDENTITY_READER);
  return new AdminSecurityService({
    drizzle: c.get(DRIZZLE),
    auth: c.get(AUTH_SESSION).auth,
    events: c.get(EVENT_BUS),
    sessions: makeSessionService(c),
    trustedDevices: makeTrustedDevices(c),
    identityReader,
    config: adminSecurityConfig(c),
    geoIp: c.has(GEO_IP_ADAPTER) ? c.get(GEO_IP_ADAPTER) : undefined,
    mailDispatch: c.get(MAIL_DISPATCH),
  });
}

export default {
  id: 'identity',
  dependsOn: ['audit'],
  requiresPorts: [MAIL_DISPATCH],
  optionalPorts: [{ port: PLAYER_PROVISIONING, without: 'registration is refused' }],
  controlPorts: [
    {
      port: GEO_CHECK_COMMANDS,
      without: 'registration and sign-in skip the country check',
      boundBy: 'compliance',
    },
    {
      port: MCP_TOKEN_REVOCATION,
      without: "ending an admin's sessions leaves their MCP tokens valid",
      boundBy: 'iam',
    },
    {
      port: PLAY_ELIGIBILITY_PROJECTION,
      without: 'a restriction reaches the ledger only when its outbox event is delivered',
      boundBy: 'wallet',
      routesOnly: true,
    },
  ],
  register(ctx) {
    let adminSecurity: AdminSecurityService | undefined;
    const resolveAdminSecurity = (c: IdentityContainer) => (adminSecurity ??= makeAdminSecurity(c));

    let realtimeTransport: RealtimeTransport | null = null;
    let playEligibilityHeartbeatRef: (() => Promise<void>) | null = null;
    ctx.jobs.worker({
      queue: PLAY_ELIGIBILITY_HEARTBEAT_QUEUE,
      schema: z.object({}),
      handler: async () => {
        if (!playEligibilityHeartbeatRef) {
          throw new Error('identity: the eligibility heartbeat ran before its router was built');
        }
        await playEligibilityHeartbeatRef();
      },
    });

    ctx.events.on('identity.sessions.revoked_all', (raw) => {
      const parsed = domainEventSchemas['identity.sessions.revoked_all'].safeParse(raw);
      if (!parsed.success) {
        return;
      }
      return realtimeTransport?.publish<SessionEventsPush>(
        sessionEventsChannel(parsed.data.userId),
        {
          type: 'revoked-all',
          ...(parsed.data.exceptSessionId ? { exceptSessionId: parsed.data.exceptSessionId } : {}),
        },
      );
    });
    ctx.events.on('identity.session.revoked', (raw) => {
      const parsed = domainEventSchemas['identity.session.revoked'].safeParse(raw);
      if (!parsed.success) {
        return;
      }
      return realtimeTransport?.publish<SessionEventsPush>(
        sessionEventsChannel(parsed.data.userId),
        {
          type: 'session-revoked',
          sessionId: parsed.data.sessionId,
        },
      );
    });
    ctx.events.on('identity.user.unlocked', (raw) => {
      const parsed = domainEventSchemas['identity.user.unlocked'].safeParse(raw);
      if (!parsed.success) {
        return;
      }
      return realtimeTransport?.publish<SessionEventsPush>(
        sessionEventsChannel(parsed.data.userId),
        {
          type: 'unlocked',
        },
      );
    });

    const withdrawalPinHmacSecret = process.env['WITHDRAWAL_PIN_HMAC_SECRET'] ?? '';
    if (withdrawalPinHmacSecret.length < MIN_WITHDRAWAL_PIN_SECRET_LENGTH) {
      throw new Error(
        `identity: WITHDRAWAL_PIN_HMAC_SECRET must be at least ${MIN_WITHDRAWAL_PIN_SECRET_LENGTH} characters - the withdrawal PIN is hashed with it`,
      );
    }

    ctx.provide(KYC_ADAPTER, () => new MockKycAdapter());
    ctx.provide(SMS_ADAPTER, () => new MockSmsAdapter());
    ctx.provide(
      ADMIN_USER_DIRECTORY,
      (c) =>
        new DrizzleAdminUserDirectory(
          c.get(DRIZZLE),
          c.get(EVENT_BUS),
          makePlayEligibilityPublisher(c),
          mcpTokenRevocation(c),
        ),
    );
    ctx.provide(MAIL_RECIPIENT_DIRECTORY, (c) => new DrizzleMailRecipientDirectory(c.get(DRIZZLE)));
    ctx.provide(IDENTITY_READER, (c) => new IdentityReaderService(c.get(DRIZZLE)));
    ctx.provide(
      ACCOUNT_READER,
      (c) => new DrizzleAccountReader(c.get(DRIZZLE), () => c.get(PLAY_ELIGIBILITY)),
    );
    const accountReaderCallerNames = parseInternalCallers(process.env['ACCOUNT_READER_CALLERS']);
    const sessionResolverCallerNames = parseInternalCallers(
      process.env['SESSION_RESOLVER_CALLERS'],
    );
    ctx.routers.addInternal('identity', (c) => ({
      ...createInternalAccountsRouter(
        new DrizzleAccountReader(c.get(DRIZZLE), () => c.get(PLAY_ELIGIBILITY)),
        accountReaderCallerNames,
      ),
      ...createInternalSessionRouter(
        c.get(LOCAL_SESSION_RESOLVER),
        resolveAdminSecurity(c),
        sessionResolverCallerNames,
      ),
    }));
    ctx.provide(
      LOGIN_ENFORCEMENT,
      (c) => new LoginEnforcementService(makeSessionService(c), makePlayEligibilityPublisher(c)),
    );
    ctx.provide(
      SESSION_IDLE_POLICY,
      (c) =>
        new SessionIdleService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          identityReader: c.get(IDENTITY_READER),
        }),
    );
    ctx.provide(PLAY_ELIGIBILITY, (c) => new PlayEligibilityService(c.get(DRIZZLE)));
    ctx.provideSealed(PLAY_ELIGIBILITY_SOURCE, (c) => ({
      page: (after, limit) => playEligibilityPage(c.get(DRIZZLE).db, after, limit),
      snapshots: (userIds) => playEligibilityOf(c.get(DRIZZLE).db, userIds),
      repair: async (userIds) => {
        const publisher = makePlayEligibilityPublisher(c);
        const failed: string[] = [];
        for (const userId of userIds) {
          try {
            await publisher.sync(userId);
          } catch (err) {
            logger.error({ err, userId }, 'identity: re-publishing play eligibility failed');
            failed.push(userId);
          }
        }
        return failed;
      },
    }));
    ctx.provide(
      FRESH_REAUTHENTICATION,
      (c) =>
        new FreshReauthenticationService({
          drizzle: c.get(DRIZZLE),
          auth: c.get(AUTH_SESSION).auth,
          twoFactorLockout: makeTwoFactorLockout(c),
        }),
    );
    ctx.provide(WITHDRAWAL_SECURITY, (c) => makeWithdrawalPin(c, withdrawalPinHmacSecret));
    ctx.provide(TWO_FACTOR_SETUP_POLICY, (c) => new TwoFactorSetupPolicyService(c.get(DRIZZLE)));
    ctx.provide(ADMIN_SECURITY_POLICY, (c) => resolveAdminSecurity(c));
    ctx.provide(
      USER_COMMANDS,
      (c) => new DrizzleUserCommands(c.get(DRIZZLE), makePlayEligibilityPublisher(c)),
    );
    ctx.provide(SESSION_COMMANDS, (c) => {
      const sessionSvc = makeSessionService(c);
      return {
        revokeAll: (userId, actorId) => sessionSvc.revokeAllSessions(userId, actorId),
      };
    });
    ctx.routers.add('identity', (c, options) => {
      if (options?.mounted !== false) {
        assertAuthSurfaceGuards(c);
        const projection = c.has(PLAY_ELIGIBILITY_PROJECTION)
          ? c.get(PLAY_ELIGIBILITY_PROJECTION)
          : null;
        if (projection) {
          playEligibilityHeartbeatRef = () => projection.heartbeat();
        }
        if (projection && projectionHeartbeatArmed(projection.remote)) {
          void projection
            .heartbeat()
            .catch((err) => logger.error({ err }, 'identity: eligibility boot heartbeat failed'));
          void c
            .get(JOB_QUEUE)
            .schedule(
              PLAY_ELIGIBILITY_HEARTBEAT_QUEUE,
              'identity-ledger-heartbeat',
              {},
              { everyMs: projectionHeartbeatEveryMs() },
            )
            .catch((err) =>
              logger.error({ err }, 'identity: eligibility heartbeat schedule failed'),
            );
        }
      }
      realtimeTransport = c.get(REALTIME_TRANSPORT);
      backfillPlayEligibilityAtBoot(c);
      const sessions = makeSessionService(c);
      return createIdentityRouter(
        new IdentityService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          audit: c.get(AUDIT_WRITER),
          identityReader: c.get(IDENTITY_READER),
          mailDispatch: c.get(MAIL_DISPATCH),
          options: c.has(IDENTITY_OPTIONS) ? c.get(IDENTITY_OPTIONS) : undefined,
          limiter: c.get(RATE_LIMITER),
          platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
          geoCheck: c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined,
          playerProvisioning: c.has(PLAYER_PROVISIONING) ? c.get(PLAYER_PROVISIONING) : undefined,
          cache: c.get(CACHE),
          trustedDevices: makeTrustedDevices(c),
          twoFactorLockout: makeTwoFactorLockout(c),
          twoFactorDelivery: new TwoFactorDeliveryService({
            drizzle: c.get(DRIZZLE),
            mailDispatch: c.get(MAIL_DISPATCH),
            sms: c.get(SMS_ADAPTER),
          }),
          sessions,
          playEligibility: makePlayEligibilityPublisher(c),
        }),
        sessions,
        new PhoneLoginService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          sms: c.get(SMS_ADAPTER),
          limiter: c.get(RATE_LIMITER),
          auth: c.get(AUTH_SESSION).auth,
          cache: c.get(CACHE),
          options: c.has(IDENTITY_OPTIONS) ? c.get(IDENTITY_OPTIONS) : undefined,
          playerProvisioning: c.has(PLAYER_PROVISIONING) ? c.get(PLAYER_PROVISIONING) : undefined,
          geoCheck: c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined,
        }),
        new PhoneVerificationService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          sms: c.get(SMS_ADAPTER),
          limiter: c.get(RATE_LIMITER),
          auth: c.get(AUTH_SESSION).auth,
          identityReader: c.get(IDENTITY_READER),
          twoFactorLockout: makeTwoFactorLockout(c),
          trustedDeviceDays: adminSecurityConfig(c).trustedDeviceDays,
        }),
        c.get(ADMIN_GUARD),
        realtimeTransport,
        resolveAdminSecurity(c),
        makeWithdrawalPin(c, withdrawalPinHmacSecret),
      );
    });
  },
} as const satisfies Plugin<CoreTokenCatalog>;
