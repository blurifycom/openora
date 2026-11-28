import {
  SupportChatProviderError,
  SupportHistoryFailureReasonSchema,
  SupportHistoryProviderError,
  type SupportHistoryFailureReason,
} from '@openora/core/contracts';

export type ProviderFailureReason =
  | SupportHistoryFailureReason
  | 'unlisted reason'
  | 'unexpected adapter error';

export const reasonOf = (err: unknown): ProviderFailureReason => {
  try {
    if (!(err instanceof SupportHistoryProviderError || err instanceof SupportChatProviderError)) {
      return 'unexpected adapter error';
    }
    const listed = SupportHistoryFailureReasonSchema.safeParse(err.reason);
    return listed.success ? listed.data : 'unlisted reason';
  } catch {
    return 'unexpected adapter error';
  }
};
