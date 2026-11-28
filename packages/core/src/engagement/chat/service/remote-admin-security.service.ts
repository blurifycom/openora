import { ORPCError } from '@orpc/server';
import {
  ADMIN_SECURITY_ROUTE,
  AdminSecurityWire,
  type AdminSecurityPolicy,
  type AdminSessionContext,
} from '@openora/core/contracts';
import { upstreamDownAs503, type InternalClient } from '@openora/core/server';

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
