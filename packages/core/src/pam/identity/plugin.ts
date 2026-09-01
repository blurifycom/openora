import {
  ADMIN_USER_DIRECTORY,
  CACHE,
  IDENTITY_READER,
  KYC_ADAPTER,
  LOGIN_ENFORCEMENT,
  PLAY_ELIGIBILITY,
  MAIL_DISPATCH,
  GEO_CHECK_COMMANDS,
  PLAYER_PROVISIONING,
  IDENTITY_OPTIONS,
  RATE_LIMITER,
  PLATFORM_CONFIG,
  SESSION_COMMANDS,
  USER_COMMANDS,
  SMS_ADAPTER,
} from '@openora/core/contracts';
import { ADMIN_GUARD, EVENT_BUS, DRIZZLE, AUTH_SESSION } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import { DrizzleUserCommands } from './service/user-commands.service.js';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { MockSmsAdapter } from './adapters/mock/mock-sms-adapter.js';
import { PhoneLoginService } from './service/phone-login.service.js';
import { DrizzleAdminUserDirectory } from './admin-user-directory.js';
import { IdentityReaderService } from './adapters/identity-reader.service.js';
import { createIdentityRouter } from './router/index.js';
import { IdentityService } from './service/identity.service.js';
import { SessionService } from './service/session.service.js';
import { LoginEnforcementService } from './service/login-enforcement.service.js';
import { PlayEligibilityService } from './service/play-eligibility.service.js';

export default {
  id: 'identity',
  register(ctx) {
    ctx.provide(KYC_ADAPTER, () => new MockKycAdapter());
    // Platform default SMS transport: logs the OTP to stdout. A consumer overlay
    // rebinds SMS_ADAPTER to a real vendor (Twilio, AWS SNS) after this plugin.
    ctx.provide(SMS_ADAPTER, () => new MockSmsAdapter());
    // The back-office depends on this port, not on the identity schema directly.
    ctx.provide(
      ADMIN_USER_DIRECTORY,
      (c) => new DrizzleAdminUserDirectory(c.get(DRIZZLE), c.get(EVENT_BUS)),
    );
    // Read-only session queries for cross-module consumers (eg tag inactive evaluation).
    ctx.provide(IDENTITY_READER, (c) => new IdentityReaderService(c.get(DRIZZLE)));
    // RG login-block writer. compliance drives it through the port, never the schema.
    ctx.provide(
      LOGIN_ENFORCEMENT,
      (c) =>
        new LoginEnforcementService(
          c.get(DRIZZLE),
          new SessionService({
            drizzle: c.get(DRIZZLE),
            events: c.get(EVENT_BUS),
            identityReader: c.get(IDENTITY_READER),
          }),
        ),
    );
    ctx.provide(PLAY_ELIGIBILITY, (c) => new PlayEligibilityService(c.get(DRIZZLE)));
    ctx.provide(USER_COMMANDS, (c) => new DrizzleUserCommands(c.get(DRIZZLE)));
    ctx.provide(SESSION_COMMANDS, (c) => {
      const sessionSvc = new SessionService({
        drizzle: c.get(DRIZZLE),
        events: c.get(EVENT_BUS),
        identityReader: c.get(IDENTITY_READER),
      });
      return {
        revokeAll: (userId, actorId) => sessionSvc.revokeAllSessions(userId, actorId),
      };
    });
    ctx.routers.add('identity', (c) =>
      createIdentityRouter(
        new IdentityService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          identityReader: c.get(IDENTITY_READER),
          // Resolved lazily (router factory runs after every plugin registered) so identity
          // does not depend on the mail plugin's load order. See ADR-0036.
          mailDispatch: c.get(MAIL_DISPATCH),
          options: c.has(IDENTITY_OPTIONS) ? c.get(IDENTITY_OPTIONS) : undefined,
          limiter: c.get(RATE_LIMITER),
          platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
          geoCheck: c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined,
          playerProvisioning: c.has(PLAYER_PROVISIONING) ? c.get(PLAYER_PROVISIONING) : undefined,
          cache: c.get(CACHE),
        }),
        new SessionService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          identityReader: c.get(IDENTITY_READER),
        }),
        new PhoneLoginService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          sms: c.get(SMS_ADAPTER),
          limiter: c.get(RATE_LIMITER),
          auth: c.get(AUTH_SESSION).auth,
          cache: c.get(CACHE),
          options: c.has(IDENTITY_OPTIONS) ? c.get(IDENTITY_OPTIONS) : undefined,
        }),
        c.get(ADMIN_GUARD),
        c.get(EVENT_BUS),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
