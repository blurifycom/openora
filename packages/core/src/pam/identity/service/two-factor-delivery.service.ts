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

export function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
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

  takeFailure(userId: User['id']): unknown {
    const failure = this.lastFailure.get(userId);
    this.lastFailure.delete(userId);
    return failure;
  }

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
      : undefined;
  }

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
      this.lastFailure.set(args.userId, error);
      throw error;
    }
  }

  private async dispatch(args: { userId: User['id']; code: string }): Promise<void> {
    const row = await this.findAccount(args.userId);
    const method = row?.twoFactorMethod;
    if (method !== 'email' && method !== 'sms') {
      return;
    }

    if (method === 'sms') {
      const phone = row.phoneVerified ? row.phoneNumber : null;
      if (!phone) {
        return;
      }
      await this.sms.sendOtp({ to: phone, code: args.code });
      return;
    }

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
