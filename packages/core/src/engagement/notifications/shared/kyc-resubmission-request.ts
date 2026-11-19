import * as z from 'zod';
import { KycTierSchema, UuidSchema, type DomainEventPayload } from '@openora/core/contracts';

// tier defaults and eventId is optional so jobs queued before either field existed still parse.
export const KycResubmissionNotifyJobSchema = z.object({
  userId: UuidSchema,
  reason: z.string().nullable(),
  tier: KycTierSchema.default('basic'),
  eventId: UuidSchema.optional(),
});

/**
 * Staff (and approved agent) resubmission requests only, for either tier; automatic sources
 * (vendor, webhook, reverify, exemption) carry their own player messaging or none.
 */
export function isStaffKycResubmissionRequest(
  payload: Pick<DomainEventPayload<'compliance.kyc.updated'>, 'status' | 'source'>,
): boolean {
  return payload.status === 'resubmission_requested' && payload.source === 'manual';
}
