import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  DEPOSIT_ADMISSION_POLICY,
  KYC_ADAPTER,
  PLATFORM_CONFIG,
  PLAYER_TAGS,
  definePlatformConfig,
  type KycAdapter,
  type KycDocument,
  type KycResult,
  type KycTier,
  type TagKey,
} from '@openora/core/contracts';

export const MIN_PLAYER_AGE = 21;
export const AGE_REVIEW_REFUSAL = 'age_verification_review';

const AGE_REVIEW_TAGS: readonly TagKey[] = ['age_verification_review', 'kyc_dob_mismatch'];

/**
 * Starts every submit at vendor `pending`. A webhook body carries the decision and the verified
 * date of birth; `resolveDecision` answers it back the way a vendor's decision API would.
 */
class DateOfBirthKycAdapter implements KycAdapter {
  readonly autoApproves = false;
  private readonly decisions = new Map<string, KycResult>();

  async submit(userId: string, _docs: KycDocument[], tier: KycTier): Promise<KycResult> {
    return { referenceId: `age-${userId}-${tier}`, status: 'pending' };
  }

  async getStatus(_userId: string, _tier: KycTier): Promise<KycResult['status']> {
    return 'pending';
  }

  parseWebhook(rawBody: string): KycResult | null {
    const parsed = JSON.parse(rawBody) as KycResult;
    this.decisions.set(parsed.referenceId, parsed);
    return { referenceId: parsed.referenceId, status: parsed.status };
  }

  async resolveDecision(referenceId: string): Promise<KycResult> {
    const decision = this.decisions.get(referenceId);
    if (!decision) {
      throw new Error(`no decision recorded for ${referenceId}`);
    }
    return decision;
  }
}

/** Binds a raised minimum age, a vendor that reports a date of birth, and a deposit gate on the age-review tags. */
export default {
  id: 'test-age-verification',
  dependsOn: ['identity', 'tag'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1', minPlayerAge: MIN_PLAYER_AGE },
      }),
    );
    ctx.provide(KYC_ADAPTER, () => new DateOfBirthKycAdapter());
    ctx.provide(DEPOSIT_ADMISSION_POLICY, (c) => ({
      async refusalReason(userId) {
        const tags = (await c.get(PLAYER_TAGS).getActiveTagKeys([userId])).get(userId) ?? [];
        return tags.some((key) => AGE_REVIEW_TAGS.includes(key)) ? AGE_REVIEW_REFUSAL : null;
      },
    }));
  },
} as const satisfies Plugin<CoreTokenCatalog>;
