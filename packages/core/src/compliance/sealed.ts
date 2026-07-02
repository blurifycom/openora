import { createSealedToken, type SealedToken } from '../contracts/adapters/index.js';

/**
 * Self-exclusion + cool-off enforcement.
 *
 * UKGC LCCP Social Responsibility Code 3.5.3 / MGA Player Protection Directive /
 * SE Spelinspektionen / DE GlüStV. Operators may not soften a self-excluded
 * player's access to the platform.
 */
export const RG_SELF_EXCLUSION_SERVICE: SealedToken<unknown> = createSealedToken(
  'rg-self-exclusion-service',
);

/**
 * National self-exclusion register checks (cross-operator).
 *
 * UKGC GamStop, SE Spelpaus, DE OASIS, DK ROFUS. The central API call may not
 * be stubbed or mocked away.
 */
export const NATIONAL_SE_REGISTRY: SealedToken<unknown> = createSealedToken(
  'national-self-exclusion-registry',
);

/**
 * AML transaction monitoring + SAR/STR write trail.
 *
 * FATF Recommendations (casino sector) / 5AMLD. Immutable, append-only,
 * time-stamped.
 */
export const AML_SAR_WRITER: SealedToken<unknown> = createSealedToken('aml-sar-writer');

/**
 * Wallet / ledger writes.
 *
 * Double-entry money movement. Adjustments go through a sealed `manualAdjust`
 * service with reason + approver - no direct ledger write from a plugin.
 */
export const LEDGER_WRITER: SealedToken<unknown> = createSealedToken('ledger-writer');

/**
 * Audit log writer.
 *
 * Append-only, content-hashed. Plugins emit events; the platform writes the
 * log entries.
 */
export const AUDIT_LOG_WRITER: SealedToken<unknown> = createSealedToken('audit-log-writer');

/**
 * Game round outcome / RNG / RTP.
 *
 * RGS / lab-certified (GLI, eCOGRA, BMM, iTechLabs). Operators cannot alter
 * outcomes, payouts, or RTP from the backoffice.
 */
export const GAME_OUTCOME_AUTHORITY: SealedToken<unknown> =
  createSealedToken('game-outcome-authority');

/**
 * Bonus wagering math.
 *
 * Operators configure parameters (rollover multiplier, contribution per game,
 * expiry); the calculation engine is sealed - regulators ask to see the
 * formula and there must be one canonical impl.
 */
export const BONUS_WAGERING_ENGINE: SealedToken<unknown> =
  createSealedToken('bonus-wagering-engine');

/**
 * RG limit-increase cooling timer.
 *
 * UKGC customer-interaction guidance (24h cool-off on UK deposit limit
 * increases) / DE GlüStV (7d). Operators cannot bypass the timer.
 */
export const RG_LIMIT_COOLING_TIMER: SealedToken<unknown> =
  createSealedToken('rg-limit-cooling-timer');

/**
 * Age verification gate.
 *
 * Cannot be conditionally skipped by a plugin.
 */
export const AGE_VERIFICATION_GATE: SealedToken<unknown> =
  createSealedToken('age-verification-gate');

/**
 * Geo-blocking platform-level deny.
 *
 * Operators can add jurisdictions to deny; they cannot remove a platform-level
 * deny (eg US, sanctions list - OFAC, EU restrictive measures).
 */
export const GEO_PLATFORM_DENY_LIST: SealedToken<unknown> =
  createSealedToken('geo-platform-deny-list');

/**
 * GDPR Art. 15 / 17 player data export + right-to-be-forgotten workflow.
 *
 * Operators may add steps (eg additional internal review) but may not remove.
 */
export const GDPR_DATA_RIGHTS_WORKFLOW: SealedToken<unknown> = createSealedToken(
  'gdpr-data-rights-workflow',
);

export const SEALED_TOKENS: readonly SealedToken<unknown>[] = [
  RG_SELF_EXCLUSION_SERVICE,
  NATIONAL_SE_REGISTRY,
  AML_SAR_WRITER,
  LEDGER_WRITER,
  AUDIT_LOG_WRITER,
  GAME_OUTCOME_AUTHORITY,
  BONUS_WAGERING_ENGINE,
  RG_LIMIT_COOLING_TIMER,
  AGE_VERIFICATION_GATE,
  GEO_PLATFORM_DENY_LIST,
  GDPR_DATA_RIGHTS_WORKFLOW,
];
