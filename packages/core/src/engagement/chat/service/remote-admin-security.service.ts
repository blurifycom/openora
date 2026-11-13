import { ORPCError } from '@orpc/server';
import {
  ADMIN_SECURITY_ROUTE,
  AdminSecurityWire,
  type AdminSecurityPolicy,
  type AdminSessionContext,
} from '@openora/core/contracts';
import { upstreamDownAs503, type InternalClient } from '@openora/core/server';

/**
 * {@link AdminSecurityPolicy} decided by the identity service, for a service whose database has
 * no `user` or `session` rows: it holds the policy's configuration, the second-factor flag and
 * the session's device, so it answers both checks and this service enforces the verdict. Never
 * cached, because the device check ends a session when it fails and the enrolment can change on
 * any request. Anything but a clean verdict refuses: an unreachable identity service is 503, a
 * refused or unreadable call is thrown as it came, never read as a pass.
 */
export class RemoteAdminSecurityPolicy implements AdminSecurityPolicy {
  constructor(private readonly client: InternalClient) {}

  assertEnrolled(context: AdminSessionContext): Promise<void> {
    return this.ask('enrolled', context);
  }

  assertSessionIntact(context: AdminSessionContext): Promise<void> {
    return this.ask('session_intact', context);
  }

  private async ask(
    check: 'enrolled' | 'session_intact',
    { userId, sessionId, ip, userAgent }: AdminSessionContext,
  ): Promise<void> {
    let refusal;
    try {
      ({ refusal } = AdminSecurityWire.output.parse(
        await this.client.request('POST', ADMIN_SECURITY_ROUTE, {
          check,
          userId,
          sessionId,
          ip,
          userAgent,
        }),
      ));
    } catch (err) {
      throw upstreamDownAs503(err);
    }
    if (refusal) {
      throw new ORPCError(refusal.code, {
        message: refusal.message,
        ...(refusal.reason ? { data: { reason: refusal.reason } } : {}),
      });
    }
  }
}
