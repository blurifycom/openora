import z from 'zod';
import { UuidSchema, defineActionType, type TagKey } from '@openora/core/contracts';

// Every other key is either computed by tag rules and compliance (kyc_*, self_excluded, level,
// inactive, high_roller, ...) or has its own action type (withdrawal_review).
export const AGENT_ASSIGNABLE_TAG_KEYS = [
  'vip',
  'bonus_abuser',
  'high_risk',
  'multi_account',
] as const satisfies readonly TagKey[];

const AgentTagReasonSchema = z.string().trim().min(1).max(500);

export const addTagAction = defineActionType({
  id: 'add_tag',
  title: 'Tag a player',
  description:
    'Flags a player with the vip, bonus_abuser, high_risk or multi_account tag and a reason ' +
    'admins can see; vip is refused unless the player is active or dormant and neither ' +
    'self-excluded nor on a cooling-off break. The three risk tags also stop automatic approval ' +
    "of the player's withdrawals while the operator keeps them in its auto-withdrawal " +
    'exclusion list, which is the default.',
  schemaVersion: 1,
  iam: { resource: 'tag', action: 'create' },
  reversible: true,
  payloadSchema: z.object({
    playerId: UuidSchema,
    tagKey: z.enum(AGENT_ASSIGNABLE_TAG_KEYS),
    reason: AgentTagReasonSchema,
  }),
  errors: ['player_not_found', 'tag_not_found', 'tag_already_active', 'player_not_eligible'],
});

export const sendToManualReviewAction = defineActionType({
  id: 'send_to_manual_review',
  title: 'Send withdrawals to manual review',
  description:
    'Tags the player withdrawal_review so every withdrawal they request from now on waits for ' +
    'an admin instead of being approved automatically; withdrawals already requested are not ' +
    'affected, and the tag stays until an admin removes it. This only works while the operator ' +
    'keeps withdrawal_review in its auto-withdrawal exclusion list, which is the default.',
  schemaVersion: 1,
  iam: { resource: 'tag', action: 'create' },
  reversible: true,
  payloadSchema: z.object({ playerId: UuidSchema, reason: AgentTagReasonSchema }),
  errors: ['player_not_found', 'already_in_manual_review'],
});
