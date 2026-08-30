import {
  ADMIN_SECURITY_POLICY,
  ADMIN_USER_DIRECTORY,
  CACHE,
  GEO_IP_ADAPTER,
  IDENTITY_READER,
  KYC_ADAPTER,
  LOGIN_ENFORCEMENT,
  PLAY_ELIGIBILITY,
  NOTIFICATION_DELIVERY_ADAPTER,
  SEND_EMAIL,
  EMAIL_TEMPLATE_RENDERER,
  GEO_CHECK_COMMANDS,
  PLAYER_PROVISIONING,
  IDENTITY_OPTIONS,
  RATE_LIMITER,
  PLATFORM_CONFIG,
  SESSION_COMMANDS,
  USER_COMMANDS,
  SMS_ADAPTER,
  AdminSecurityConfigSchema,
} from '@openora/core/contracts';
import { ADMIN_GUARD, EVENT_BUS, DRIZZLE, AUTH_SESSION } from '@openora/core/server';
import type { CoreTokenCatalog, Plugin, TypedContainer } from '@openora/core/server';
import { DrizzleUserCommands } from './service/user-commands.service.js';
import { MockKycAdapter } from './adapters/mock/mock-kyc-adapter.js';
import { MockSmsAdapter } from './adapters/mock/mock-sms-adapter.js';
import { PhoneLoginService } from './service/phone-login.service.js';
import { DefaultEmailTemplateRenderer } from './adapters/default-email-template-renderer.js';
import { DrizzleAdminUserDirectory } from './admin-user-directory.js';
import { IdentityReaderService } from './adapters/identity-reader.service.js';
import { createIdentityRouter } from './router/index.js';
import { IdentityService } from './service/identity.service.js';
import { SessionService } from './service/session.service.js';
import { AdminSecurityService } from './service/admin-security.service.js';
import { TrustedDeviceService } from './service/trusted-device.service.js';
import { TwoFactorLockoutService } from './service/two-factor-lockout.service.js';
import { LoginEnforcementService } from './service/login-enforcement.service.js';
import { PlayEligibilityService } from './service/play-eligibility.service.js';

type IdentityContainer = TypedContainer<CoreTokenCatalog>;

function adminSecurityConfig(c: IdentityContainer) {
  const platformConfig = c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined;
  return platformConfig?.adminSecurity ?? AdminSecurityConfigSchema.parse({});
}

function makeTrustedDevices(c: IdentityContainer) {
  return new TrustedDeviceService({
    drizzle: c.get(DRIZZLE),
    events: c.get(EVENT_BUS),
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

function makeAdminSecurity(c: IdentityContainer) {
  const identityReader = c.get(IDENTITY_READER);
  return new AdminSecurityService({
    drizzle: c.get(DRIZZLE),
    events: c.get(EVENT_BUS),
    sessions: new SessionService({
      drizzle: c.get(DRIZZLE),
      events: c.get(EVENT_BUS),
      identityReader,
    }),
    trustedDevices: makeTrustedDevices(c),
    identityReader,
    config: adminSecurityConfig(c),
    geoIp: c.has(GEO_IP_ADAPTER) ? c.get(GEO_IP_ADAPTER) : undefined,
  });
}

export default {
  id: 'identity',
  register(ctx) {
    // Built once and shared by ADMIN_SECURITY_POLICY and the router below - two
    // separate `makeAdminSecurity(c)` calls would construct two independent
    // instances wrapping the same singletons, harmless today but silently
    // stranding an overlay's ADMIN_SECURITY_POLICY rebind: the router would keep
    // calling the original.
    let adminSecurity: AdminSecurityService | undefined;
    const resolveAdminSecurity = (c: IdentityContainer) => (adminSecurity ??= makeAdminSecurity(c));

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
          new SessionService({
            drizzle: c.get(DRIZZLE),
            events: c.get(EVENT_BUS),
            identityReader: c.get(IDENTITY_READER),
          }),
        ),
    );
    ctx.provide(PLAY_ELIGIBILITY, (c) => new PlayEligibilityService(c.get(DRIZZLE)));
    // Mandatory-2FA + session-fingerprint enforcement. AdminGuard resolves this on every
    // admin request; leaving it unbound turns both checks off, which is why it is bound
    // here rather than behind a feature flag.
    ctx.provide(ADMIN_SECURITY_POLICY, (c) => resolveAdminSecurity(c));
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
          email: c.get(SEND_EMAIL),
          templateRenderer: c.get(EMAIL_TEMPLATE_RENDERER),
          options: c.has(IDENTITY_OPTIONS) ? c.get(IDENTITY_OPTIONS) : undefined,
          limiter: c.get(RATE_LIMITER),
          platformConfig: c.has(PLATFORM_CONFIG) ? c.get(PLATFORM_CONFIG) : undefined,
          geoCheck: c.has(GEO_CHECK_COMMANDS) ? c.get(GEO_CHECK_COMMANDS) : undefined,
          playerProvisioning: c.has(PLAYER_PROVISIONING) ? c.get(PLAYER_PROVISIONING) : undefined,
          cache: c.get(CACHE),
          trustedDevices: makeTrustedDevices(c),
          twoFactorLockout: makeTwoFactorLockout(c),
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
        resolveAdminSecurity(c),
      ),
    );
  },
} as const satisfies Plugin<CoreTokenCatalog>;
