/**
 * Email-send seam. The identity module uses this to deliver password-reset and
 * verification emails. The default implementation delegates to
 * NOTIFICATION_DELIVERY_ADAPTER (log-to-stdout in dev); operators swap it via
 * an overlay: ctx.provide(SEND_EMAIL, () => new MyEmailAdapter())
 * Load your overlay AFTER the identity plugin in extensions.config.ts.
 */
import { createToken, type Token } from './token.js';

export type SendEmailPort = {
  send(input: { to: string; subject: string; body: string }): Promise<void>;
};

export const SEND_EMAIL: Token<SendEmailPort> = createToken<SendEmailPort>('SEND_EMAIL');
