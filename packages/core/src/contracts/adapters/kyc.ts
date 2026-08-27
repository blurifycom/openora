/**
 * KYC/identity-verification seam. Intended real provider: SumSub (https://sumsub.com).
 * The identity module ships MockKycAdapter (auto-approves) as the default binding.
 * Override via overlay: `ctx.provide(KYC_ADAPTER, () => new SumsubKycAdapter())`.
 * Load your overlay AFTER the identity plugin in extensions.config.ts (last registration wins).
 * See docs/adapters/kyc.md for the full binding guide.
 */
import * as z from 'zod';
import { createToken, type Token } from './token.js';
import type { KycStatus, KycStatusSource, KycTier, Player } from '../schemas/player.js';

export type KycDocument = {
  type: 'passport' | 'drivers_license' | 'national_id';
  frontUrl: string;
  backUrl?: string;
};

export const KYC_VENDOR_STATUSES = ['pending', 'approved', 'rejected', 'not_started'] as const;
export type KycVendorStatus = (typeof KYC_VENDOR_STATUSES)[number];

/**
 * Vendor-neutral outcome of a single workflow step (eg an ID check, a liveness check,
 * an AML screen). `approved` is the only terminal-successful value; every other value
 * (including `unknown`, used when a vendor reports a step status this platform does
 * not recognize) means the step has not reached a successful state.
 */
export const KYC_CHECK_STATUSES = [
  'not_started',
  'in_progress',
  'in_review',
  'approved',
  'declined',
  'expired',
  'unknown',
] as const;
export const KycCheckStatusSchema = z.enum(KYC_CHECK_STATUSES);
export type KycCheckStatus = z.infer<typeof KycCheckStatusSchema>;

/** One workflow step's outcome. `step` is a free-form, vendor-supplied label (eg Didit's `ID_VERIFICATION`). */
export const KycCheckResultSchema = z.object({
  step: z.string(),
  status: KycCheckStatusSchema,
});
export type KycCheckResult = z.infer<typeof KycCheckResultSchema>;

export type KycResult = {
  referenceId: string;
  status: KycVendorStatus;
  /**
   * Hosted verification URL to redirect the end user to, for vendors whose flow collects
   * documents on their own hosted page (eg Didit) rather than accepting them from our
   * backend. Omitted by document-forwarding vendors (eg SumSub, MockKycAdapter).
   */
  verificationUrl?: string;
  /** Document types the vendor's decision covers, when it reports them. */
  documentTypes?: KycDocument['type'][];
  /** Vendor-supplied human-readable reason for the decision (eg a rejection cause). */
  decisionReason?: string;
  /**
   * Per-step outcomes for every workflow step the vendor considers part of THIS
   * session (eg Didit's decision `features` list) - vendor-neutral, and inherently
   * self-updating when the vendor-side workflow graph changes, since it is derived
   * from the same session's decision payload rather than a separately maintained
   * step list. Omitted by vendors/adapters with no step-level granularity (eg
   * MockKycAdapter, a document-forwarding vendor). The compliance completeness gate
   * (`KycVerificationService.reconcile`) requires every entry to be `approved`
   * before it lets a vendor `approved` status stand; a missing/incomplete step
   * routes the decision to `resubmission_requested` instead.
   */
  checks?: KycCheckResult[];
};

/**
 * Vendor-neutral device/IP risk signals resolved for a KYC verification session.
 * Hosted-session vendors (eg Didit) extract these from their own session decision;
 * document-forwarding vendors and MockKycAdapter have no session-level device/IP
 * telemetry to report and omit the port method entirely rather than returning a
 * default-false shape.
 */
export type KycRiskSignals = {
  vpnOrTorDetected: boolean;
  dataCenterIpDetected: boolean;
  duplicateDeviceDetected: boolean;
  highRiskCountryDetected: boolean;
  deviceFingerprints: string[];
};

export type KycAdapter = {
  /**
   * True when the adapter rubber-stamps every submission (the default MockKycAdapter).
   * A boot guard refuses/warns if withdrawals are KYC-gated while this is bound, so an
   * operator can't enable the gate yet leave verification a no-op. Real providers omit it.
   */
  readonly autoApproves?: boolean;
  submit(userId: string, documents: KycDocument[], tier: KycTier): Promise<KycResult>;
  getStatus(userId: string, tier: KycTier): Promise<KycVendorStatus>;
  /**
   * Provider-specific normalization of a raw webhook into a vendor decision, or
   * null when the body is not a reconcilable decision. Optional - MockKycAdapter
   * omits it; the Didit/SumSub overlay implements it.
   */
  parseWebhook?(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): KycResult | null;
  /**
   * Fetches the full decision for a reference id - documentTypes, decisionReason,
   * and the authoritative status - from the vendor. Optional: document-forwarding
   * vendors and MockKycAdapter have nothing to resolve (the webhook/submit payload
   * IS the decision); a hosted-session vendor (eg Didit) implements it so the
   * `kyc-decision-sync` job can enrich the webhook's bare referenceId+status with
   * the full decision off the request path, never awaited inline in the webhook
   * handler (Didit's own SLA is ~5s with 2 retries - the webhook route must not
   * inherit that latency).
   */
  resolveDecision?(referenceId: string): Promise<KycResult>;
  /**
   * Fetches device/IP risk signals for a reference id. Optional - the signals only
   * exist as part of a vendor's hosted verification session, never at signup, so
   * only a hosted-session vendor (eg Didit) implements it; document-forwarding
   * vendors and MockKycAdapter omit it. Called by the `kyc-decision-sync` job
   * alongside `resolveDecision`, off the webhook request path.
   */
  resolveRiskSignals?(referenceId: string): Promise<KycRiskSignals>;
};

export const KYC_ADAPTER: Token<KycAdapter> = createToken('KYC_ADAPTER');

/**
 * Single-writer port for `player.kycStatus`. The invariant is enforced structurally,
 * not by a sealed token: pam owns the `player` table and binds the only implementation,
 * so every Basic status change (admin override, vendor decision, webhook, threshold re-KYC)
 * routes through one write. Compliance emits the corresponding `compliance.kyc.updated`
 * event after its transaction commits. An overlay MAY rebind this port, but it MUST
 * preserve the transition result or the audit trail cannot be emitted.
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
  ): Promise<KycStatusTransition | null>;
};

export type KycStatusTransition = {
  playerId: Player['id'];
  previousStatus: KycStatus;
};

export const KYC_STATUS_WRITER: Token<KycStatusWriter> = createToken('KYC_STATUS_WRITER');

/**
 * Verifies the public KYC provider webhook is genuine. The default impl recomputes
 * an HMAC-SHA256 over the raw request body and constant-time compares it against the
 * `x-kyc-signature` header; a vendor overlay rebinds it. Fails closed when the secret is
 * unset, the signature is absent, or the raw body was not captured. Takes the full
 * headers map (not a pre-extracted value) because the signing header name is
 * vendor-specific - eg SumSub vs a hosted-session vendor each names it differently -
 * so each implementation extracts whatever header(s) it actually needs. Async (a
 * `boolean` return also satisfies the type) because a real implementation - the
 * default `HmacKycWebhookVerifier` included - checks replay protection against a
 * store, not just the signature bytes; a captured valid signature must not be
 * honored forever.
 */
export type KycWebhookVerifier = {
  verify(
    rawBody: string,
    headers: Record<string, string | string[] | undefined>,
  ): boolean | Promise<boolean>;
};

export const KYC_WEBHOOK_VERIFIER: Token<KycWebhookVerifier> = createToken('KYC_WEBHOOK_VERIFIER');
