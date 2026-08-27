import * as z from 'zod';

// `session` is a Responsible-Gambling session-time limit: a `user_limit` row with
// type='session', period='session', amount = minutes.
export const limitTypes = ['deposit', 'wager', 'loss', 'session'] as const;
export const LimitTypeSchema = z.enum(limitTypes);
export type LimitType = z.infer<typeof LimitTypeSchema>;

export const limitPeriods = ['daily', 'weekly', 'monthly', 'session'] as const;
export const LimitPeriodSchema = z.enum(limitPeriods);
export type LimitPeriod = z.infer<typeof LimitPeriodSchema>;

export const geoRuleActions = ['allow', 'block'] as const;
export const GeoRuleActionSchema = z.enum(geoRuleActions);
export type GeoRuleAction = z.infer<typeof GeoRuleActionSchema>;

export const EXCLUSION_KINDS = ['cooling_off', 'self_exclusion'] as const;
export const ExclusionKindSchema = z.enum(EXCLUSION_KINDS);
export type ExclusionKind = z.infer<typeof ExclusionKindSchema>;

export const EXCLUSION_STATUSES = ['active', 'lifted', 'expired'] as const;
export const ExclusionStatusSchema = z.enum(EXCLUSION_STATUSES);
export type ExclusionStatus = z.infer<typeof ExclusionStatusSchema>;

export const RG_FLAG_TYPES = ['limit_threshold', 'session_time', 'self_excluded_login'] as const;
export const RgFlagTypeSchema = z.enum(RG_FLAG_TYPES);
export type RgFlagType = z.infer<typeof RgFlagTypeSchema>;

export const RG_FLAG_STATUSES = ['active', 'cleared'] as const;
export const RgFlagStatusSchema = z.enum(RG_FLAG_STATUSES);
export type RgFlagStatus = z.infer<typeof RgFlagStatusSchema>;

// A pending limit change is either a raise or a full removal - both weaken the
// protection, so both serve the cool-down. Lowering a limit is neither: it lands at once.
export const LIMIT_CHANGE_KINDS = ['increase', 'removal'] as const;
export const LimitChangeKindSchema = z.enum(LIMIT_CHANGE_KINDS);
export type LimitChangeKind = z.infer<typeof LimitChangeKindSchema>;

// Who drove an RG action. `system` is the clock (a sweep expiring something), never a
// person. The audit log attributes the actor from this, so a player's own limit change
// is no longer filed as an admin action.
export const RG_INITIATORS = ['player', 'admin', 'system'] as const;
export const RgInitiatorSchema = z.enum(RG_INITIATORS);
export type RgInitiator = z.infer<typeof RgInitiatorSchema>;
