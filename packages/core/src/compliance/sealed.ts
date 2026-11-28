import {
  AUDIT_WRITER,
  BONUS_FUND_LOCKS,
  BONUS_WAGERING,
  LEDGER_PLAY_ELIGIBILITY,
  PLAY_ELIGIBILITY_PROJECTION,
  PLAY_ELIGIBILITY_SOURCE,
  RG_LIMITS,
  RG_LIMIT_LEDGER,
  RG_LIMITS_SOURCE,
  createSealedToken,
  type SealedToken,
} from '@openora/core/contracts';

export const RG_SELF_EXCLUSION_SERVICE: SealedToken<unknown> = createSealedToken(
  'rg-self-exclusion-service',
);

export const NATIONAL_SE_REGISTRY: SealedToken<unknown> = createSealedToken(
  'national-self-exclusion-registry',
);

export const AML_SAR_WRITER: SealedToken<unknown> = createSealedToken('aml-sar-writer');

export const LEDGER_WRITER: SealedToken<unknown> = createSealedToken('ledger-writer');

export const GAME_OUTCOME_AUTHORITY: SealedToken<unknown> =
  createSealedToken('game-outcome-authority');

export const RG_LIMIT_COOLING_TIMER: SealedToken<unknown> =
  createSealedToken('rg-limit-cooling-timer');

export const AGE_VERIFICATION_GATE: SealedToken<unknown> =
  createSealedToken('age-verification-gate');

export const GEO_PLATFORM_DENY_LIST: SealedToken<unknown> =
  createSealedToken('geo-platform-deny-list');

export const GDPR_DATA_RIGHTS_WORKFLOW: SealedToken<unknown> = createSealedToken(
  'gdpr-data-rights-workflow',
);

export const SEALED_TOKENS: readonly SealedToken<unknown>[] = [
  RG_SELF_EXCLUSION_SERVICE,
  NATIONAL_SE_REGISTRY,
  AML_SAR_WRITER,
  LEDGER_WRITER,
  AUDIT_WRITER,
  GAME_OUTCOME_AUTHORITY,
  BONUS_WAGERING,
  BONUS_FUND_LOCKS,
  RG_LIMIT_COOLING_TIMER,
  AGE_VERIFICATION_GATE,
  GEO_PLATFORM_DENY_LIST,
  GDPR_DATA_RIGHTS_WORKFLOW,
  LEDGER_PLAY_ELIGIBILITY,
  PLAY_ELIGIBILITY_PROJECTION,
  RG_LIMITS,
  RG_LIMIT_LEDGER,
  PLAY_ELIGIBILITY_SOURCE,
  RG_LIMITS_SOURCE,
];

export const IMPLEMENTED_SEALED_TOKENS: readonly SealedToken<unknown>[] = [AUDIT_WRITER];
