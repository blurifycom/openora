import { randomUUID } from 'node:crypto';
import * as z from 'zod';
import type { CoreTokenCatalog, Plugin } from '@openora/core/server';
import {
  GEO_IP_ADAPTER,
  KYC_ADAPTER,
  KYC_VENDOR_STATUSES,
  KycCheckResultSchema,
  PLATFORM_CONFIG,
  definePlatformConfig,
  type KycAdapter,
} from '@openora/core/contracts';

const TierSchema = z.enum(['basic', 'advanced']);

export const KycDirectiveSchema = z.object({
  submit: z.enum(KYC_VENDOR_STATUSES).default('pending'),
  decision: z.enum(KYC_VENDOR_STATUSES).default('approved'),
  checks: z.array(KycCheckResultSchema).optional(),
  dateOfBirth: z.string().optional(),
  resolvedTier: TierSchema.optional(),
  ref: z.string().optional(),
});

export type KycDirective = z.input<typeof KycDirectiveSchema>;

const WebhookSchema = z.object({
  referenceId: z.string(),
  status: z.enum(KYC_VENDOR_STATUSES),
  tier: TierSchema.optional(),
});

export const COUNTRY_POOL = ['FI', 'SE', 'NO', 'DK', 'IS', 'EE', 'LV', 'LT', 'PT', 'GR'] as const;

export const ipForCountry = (country: (typeof COUNTRY_POOL)[number]) =>
  `10.77.${COUNTRY_POOL.indexOf(country)}.1`;

export const directiveSegment = (directive: KycDirective) =>
  Buffer.from(JSON.stringify(directive)).toString('base64url');

const readDirective = (segment: string) =>
  KycDirectiveSchema.parse(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')));

const segmentOfReference = (referenceId: string) =>
  referenceId.slice(referenceId.lastIndexOf('.') + 1);

const segmentOfUrl = (url: string) => url.slice(url.lastIndexOf('/') + 1);

const adapter: KycAdapter = {
  async submit(_userId, documents) {
    const segment = segmentOfUrl(documents[0]?.frontUrl ?? '');
    const directive = readDirective(segment);
    return {
      referenceId: `${directive.ref ?? randomUUID()}.${segment}`,
      status: directive.submit,
    };
  },
  async getStatus() {
    return 'pending';
  },
  parseWebhook(rawBody) {
    const parsed = WebhookSchema.safeParse(JSON.parse(rawBody) as unknown);
    if (!parsed.success) {
      return null;
    }
    const { referenceId, status, tier } = parsed.data;
    return tier ? { referenceId, status, tier } : { referenceId, status };
  },
  async resolveDecision(referenceId) {
    const directive = readDirective(segmentOfReference(referenceId));
    return {
      referenceId,
      status: directive.decision,
      ...(directive.checks ? { checks: directive.checks } : {}),
      ...(directive.dateOfBirth ? { dateOfBirth: directive.dateOfBirth } : {}),
      ...(directive.resolvedTier ? { tier: directive.resolvedTier } : {}),
    };
  },
};

export default {
  id: 'testing-kyc',
  dependsOn: ['identity', 'compliance', 'wallet'],
  register(ctx) {
    ctx.provide(PLATFORM_CONFIG, () =>
      definePlatformConfig({
        registration: { termsVersion: 'test-v1' },
        kyc: { provider: 'test-kyc', gateWithdrawals: true },
      }),
    );
    ctx.provide(KYC_ADAPTER, () => adapter);
    ctx.provide(GEO_IP_ADAPTER, () => ({
      async lookup(ipAddress: string) {
        const match = /^10\.77\.(\d+)\.1$/.exec(ipAddress);
        return { countryCode: match ? (COUNTRY_POOL[Number(match[1])] ?? null) : null };
      },
    }));
  },
} satisfies Plugin<CoreTokenCatalog>;
