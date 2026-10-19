import { createToken, type Token } from './token.js';

/**
 * Decides whether an on-chain deposit that already reached the platform is held for review
 * instead of credited. The funds are on the chain, so a deposit cannot be refused; holding it
 * records the deposit as `on_hold`, moves no balance, and files a `held_deposit` finding an
 * admin resolves by releasing it (asked again here) or refunding it on chain. A `credited`
 * resolution of any other deposit finding asks this policy too.
 *
 * `tx` is the crediting transaction, already holding the player's deposit lock, so a limit
 * read on it counts every deposit committed before this one. Returns the hold reason, or
 * `null` to credit. A throw rolls the credit back and fails the webhook, so the vendor
 * redelivers it.
 *
 * Optional (`c.has`); unbound, every attributed deposit is credited and a deposit-limit
 * breach is only flagged.
 */
export type DepositHoldPolicy = {
  holdReason(
    tx: unknown,
    deposit: { userId: string; amount: string; currency: string },
  ): Promise<string | null>;
};

export const DEPOSIT_HOLD_POLICY: Token<DepositHoldPolicy> =
  createToken<DepositHoldPolicy>('DEPOSIT_HOLD_POLICY');
