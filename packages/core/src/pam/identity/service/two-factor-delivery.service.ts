import { randomUUID } from 'node:crypto';
import { DrizzleService } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import type {
  MailDispatchPort,
  SmsAdapter,
  TwoFactorDeliveryMethod,
  User,
} from '@openora/core/contracts';
import { user } from '../schema/index.js';

/**
 * Masks a registered address down to what is safe to show an unauthenticated (or
 * merely half-authenticated) caller: enough to recognise which of your own addresses
 * a code went to, not enough to learn the address from the screen.
 */
export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  // A one-character local part has nothing to keep and nothing to hide; showing it
  // whole would leak the entire address, so it masks to a bare marker.
  const head = local.length > 1 ? local.slice(0, 1) : '';
  return `${head}***@${domain}`;
}

export function maskPhone(phone: string): string {
  const tail = phone.slice(-2);
  return `+** *** *** ${tail}`;
}

export type TwoFactorDeliveryDeps = {
  drizzle: DrizzleService;
  mailDispatch?: MailDispatchPort;
  sms: SmsAdapter;
};

type TwoFactorDestination = {
  method: TwoFactorDeliveryMethod;
  masked: string;
};

/**
 * Delivers a one-time second-factor code over whichever transport the account's
 * enrolled method names. better-auth generates and verifies the code itself; this
 * only decides where it goes, which is the one thing the plugin cannot know - it
 * sees a single enrolment and no notion of `app` vs `email` vs `sms`.
 */
export class TwoFactorDeliveryService {
  private readonly drizzle: DrizzleService;
  private readonly mailDispatch?: MailDispatchPort;
  private readonly sms: SmsAdapter;
  private readonly lastFailure = new Map<User['id'], unknown>();

  constructor({ drizzle, mailDispatch, sms }: TwoFactorDeliveryDeps) {
    this.drizzle = drizzle;
    this.mailDispatch = mailDispatch;
    this.sms = sms;
  }

  /**
   * The transport error from this account's most recent `deliver`, cleared as it is
   * read. better-auth's send-otp endpoint wraps the hook in `.catch(logger.error)` and
   * answers 200 regardless, so without this the API would promise a code that is
   * never coming. The hook runs inline (no `backgroundTasks.handler` is configured),
   * so a failure is already recorded by the time the endpoint returns.
   *
   * What this actually catches differs by transport: `sms` calls the vendor
   * synchronously, so a real rejection lands here. `email` only enqueues a mail job
   * (`MailDispatchPort.toUser`) - this catches the queue being unreachable, not a
   * later SMTP-level bounce, the same fire-and-forget contract every other email in
   * this codebase runs under (registration, password reset). A player recovers from
   * either case the same way: `sendTwoFactorOtp` re-reads the persisted method and
   * tries again.
   */
  takeFailure(userId: User['id']): unknown {
    const failure = this.lastFailure.get(userId);
    this.lastFailure.delete(userId);
    return failure;
  }

  /**
   * Where a code for this account would go, masked. Returns undefined for an account
   * on the `app` method (nothing is delivered) or one that is not enrolled at all.
   */
  async describeDestination(userId: User['id']): Promise<TwoFactorDestination | undefined> {
    const row = await this.findAccount(userId);
    if (!row?.twoFactorMethod || row.twoFactorMethod === 'app') {
      return undefined;
    }
    if (row.twoFactorMethod === 'email') {
      return { method: 'email', masked: maskEmail(row.email) };
    }
    return row.phoneVerified && row.phoneNumber
      ? { method: 'sms', masked: maskPhone(row.phoneNumber) }
      : // An `sms` enrolment whose phone has since been cleared or unverified has
        // nowhere to send to - and must report that the same way `deliver` decides it.
        undefined;
  }

  /**
   * Fans a generated code out to the account's chosen transport. Bound as better-auth's
   * `sendOTP` hook, so it runs for every OTP the plugin issues - enrolment, resend and
   * the send leg of a login challenge alike.
   */
  async deliver(args: {
    userId: User['id'];
    email: string;
    phoneNumber: string | null;
    code: string;
  }): Promise<void> {
    this.lastFailure.delete(args.userId);
    try {
      await this.dispatch(args);
    } catch (error) {
      // Recorded rather than only thrown: better-auth swallows whatever this hook
      // throws and still answers 200, so the caller learns of a dead transport only
      // by reading it back through `takeFailure`.
      this.lastFailure.set(args.userId, error);
      throw error;
    }
  }

  private async dispatch(args: { userId: User['id']; code: string }): Promise<void> {
    const row = await this.findAccount(args.userId);
    const method = row?.twoFactorMethod;
    // `app` reads the code off the shared secret and an unenrolled account has no
    // method yet, so neither has anywhere to deliver to. Staying silent is correct:
    // better-auth calls this hook unconditionally.
    if (method !== 'email' && method !== 'sms') {
      return;
    }

    if (method === 'sms') {
      // Only a verified number. Enrolment checks this too, but a second factor must
      // never be routed to a number the account has not proven it holds, however the
      // column came to have it.
      const phone = row.phoneVerified ? row.phoneNumber : null;
      if (!phone) {
        return;
      }
      await this.sms.sendOtp({ to: phone, code: args.code });
      return;
    }

    // Routed through the dispatch port rather than a raw sender so the code inherits
    // the platform's per-user locale, rendering and delivery log like every other mail.
    // The key is fresh per send: a resent code is a new mail, not a retry of the old one.
    await this.mailDispatch?.toUser({
      userId: args.userId,
      template: { key: 'twoFactorOtp', data: { otp: args.code } },
      idempotencyKey: `otp:twoFactorOtp:${randomUUID()}`,
    });
  }

  private async findAccount(userId: User['id']) {
    const [row] = await this.drizzle.db
      .select({
        email: user.email,
        phoneNumber: user.phoneNumber,
        phoneVerified: user.phoneVerified,
        twoFactorMethod: user.twoFactorMethod,
      })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row;
  }
}
