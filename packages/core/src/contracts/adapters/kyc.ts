/**
 * KYC/identity-verification seam. Intended real provider: SumSub (https://sumsub.com).
 * The identity module ships MockKycAdapter (auto-approves) as the default binding.
 * Override via overlay: `ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter())`.
 * Load your overlay AFTER the identity plugin in extensions.config.ts (last registration wins).
 * See docs/adapters/kyc.md for the full binding guide.
 */
import { createToken, type Token } from './token.js';
import type { KycStatus, Player } from '../schemas/player.js';

export type KycStatusSource = 'vendor' | 'manual' | 'webhook' | 'reverify';

export type KycDocument = {
  type: 'passport' | 'drivers_license' | 'national_id';
  frontUrl: string;
  backUrl?: string;
};

export type KycVendorStatus = 'pending' | 'approved' | 'rejected' | 'not_started';

export type KycResult = {
  referenceId: string;
  status: KycVendorStatus;
  /**
   * Hosted verification URL to redirect the end user to, for vendors whose flow collects
   * documents on their own hosted page (eg Didit) rather than accepting them from our
   * backend. Omitted by document-forwarding vendors (eg SumSub, MockKycAdapter).
   */
  verificationUrl?: string;
};

export type KycAdapter = {
  /**
   * True when the adapter rubber-stamps every submission (the default MockKycAdapter).
   * A boot guard refuses/warns if withdrawals are KYC-gated while this is bound, so an
   * operator can't enable the gate yet leave verification a no-op. Real providers omit it.
   */
  readonly autoApproves?: boolean;
  submit(userId: string, documents: KycDocument[]): Promise<KycResult>;
  getStatus(userId: string): Promise<KycVendorStatus>;
  /**
   * Provider-specific normalization of a raw webhook into a vendor decision, or
   * null when the body is not a reconcilable decision. Optional - MockKycAdapter
   * omits it; the Didit/SumSub overlay implements it.
   */
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): KycResult | null;
};

export const KYC_ADAPTER: Token<KycAdapter> = createToken('KYC_ADAPTER');

/**
 * Single-writer port for `player.kycStatus`. The invariant is enforced structurally,
 * not by a sealed token: pam owns the `player` table and binds the only implementation,
 * so every status change (admin override, vendor decision, webhook, threshold re-KYC)
 * routes through one write + one `compliance.kyc.updated` emit. An overlay MAY rebind
 * this port, but it MUST preserve that audit emit - dropping it breaks the 5AMLD trail.
 * `actorId` is the admin who acted, or null for a system change (vendor/webhook/re-KYC).
 * `source` records what drove it. `tx` is the caller's active transaction handle to stay
 * atomic with the caller's own writes (e.g. the player-management update), else the writer
 * uses its own; typed `unknown` because this contracts-zone port cannot import drizzle's
 * transaction type - matches the WALLET_COMMANDS convention.
 */
export type KycStatusWriter = {
  setStatus(
    userId: Player['userId'],
    status: KycStatus,
    opts: { actorId: Player['userId'] | null; reason?: string; source: KycStatusSource },
    tx?: unknown,
  ): Promise<void>;
};

export const KYC_STATUS_WRITER: Token<KycStatusWriter> = createToken('KYC_STATUS_WRITER');

/**
 * Verifies the public KYC provider webhook is genuine. The default impl recomputes
 * an HMAC-SHA256 over the raw request body and constant-time compares it against the
 * `x-kyc-signature` header; a vendor overlay rebinds it. Fails closed when the secret is
 * unset, the signature is absent, or the raw body was not captured. Takes the full
 * headers map (not a pre-extracted value) because the signing header name is
 * vendor-specific - eg SumSub vs a hosted-session vendor each names it differently -
 * so each implementation extracts whatever header(s) it actually needs.
 */
export type KycWebhookVerifier = {
  verify(rawBody: string, headers: Record<string, string | string[] | undefined>): boolean;
};

export const KYC_WEBHOOK_VERIFIER: Token<KycWebhookVerifier> = createToken('KYC_WEBHOOK_VERIFIER');
