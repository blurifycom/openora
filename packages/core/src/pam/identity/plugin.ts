import {
  ADMIN_USER_DIRECTORY,
  CACHE,
  IDENTITY_READER,
  KYC_ADAPTER,
  LOGIN_ENFORCEMENT,
  PLAY_ELIGIBILITY,
  NOTIFICATION_DELIVERY_ADAPTER,
  SEND_EMAIL,
  EMAIL_TEMPLATE_RENDERER,
  IDENTITY_OPTIONS,
  RATE_LIMITER,
  PLATFORM_CONFIG,
  SESSION_COMMANDS,
  SMS_ADAPTER,
} from '@openora/core/contracts';
import { definePlugin, ADMIN_GUARD, EVENT_BUS, DRIZZLE, AUTH_SESSION } from '@openora/core/server';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { MockSmsAdapter } from './adapters/mock/mock-sms-adapter.js';
import { PhoneLoginService } from './service/phone-login.service.js';
import { DefaultEmailTemplateRenderer } from './adapters/default-email-template-renderer.js';
import { DrizzleAdminUserDirectory } from './admin-user-directory.js';
import { IdentityReaderService } from './adapters/identity-reader.service.js';
import { createIdentityRouter } from './router/index.js';
import { IdentityService } from './service/identity.service.js';
import { SessionService } from './service/session.service.js';
import { LoginEnforcementService } from './service/login-enforcement.service.js';
import { PlayEligibilityService } from './service/play-eligibility.service.js';

export default definePlugin({
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
    // Resolved lazily so identity does not depend on the notifications plugin's load order.
    ctx.provide(SEND_EMAIL, (c) => ({
      send: ({ to, subject, body }) =>
        c.get(NOTIFICATION_DELIVERY_ADAPTER).sendEmail(to, subject, body),
    }));
    ctx.provide(EMAIL_TEMPLATE_RENDERER, () => new DefaultEmailTemplateRenderer());
    // RG login-block writer. compliance drives it through the port, never the schema.
    ctx.provide(
      LOGIN_ENFORCEMENT,
      (c) =>
        new LoginEnforcementService(
          c.get(DRIZZLE),
          new SessionService({ drizzle: c.get(DRIZZLE), events: c.get(EVENT_BUS) }),
        ),
    );
    // RG wager gate. Gaming and wallet refuse a bet through this port so a restricted
    // player cannot keep playing on a session that outlived the block.
    ctx.provide(PLAY_ELIGIBILITY, (c) => new PlayEligibilityService(c.get(DRIZZLE)));
    ctx.provide(SESSION_COMMANDS, (c) => {
      const sessionSvc = new SessionService({ drizzle: c.get(DRIZZLE), events: c.get(EVENT_BUS) });
      return {
        revokeAll: (userId, actorId) => sessionSvc.revokeAllSessions(userId, actorId),
      };
    });
    ctx.routers.add('identity', (c) =>
      createIdentityRouter(
        new IdentityService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          email: c.get(SEND_EMAIL),
          templateRenderer: c.get(EMAIL_TEMPLATE_RENDERER),
          options: c.has(IDENTITY_OPTIONS) ? c.get(IDENTITY_OPTIONS) : undefined,
          limiter: c.get(RATE_LIMITER),
          platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
          cache: c.get(CACHE),
        }),
        new SessionService({ drizzle: c.get(DRIZZLE), events: c.get(EVENT_BUS) }),
        new PhoneLoginService({
          drizzle: c.get(DRIZZLE),
          events: c.get(EVENT_BUS),
          sms: c.get(SMS_ADAPTER),
          limiter: c.get(RATE_LIMITER),
          auth: c.get(AUTH_SESSION).auth,
          cache: c.get(CACHE),
        }),
        c.get(ADMIN_GUARD),
        c.get(EVENT_BUS),
      ),
    );
  },
});
