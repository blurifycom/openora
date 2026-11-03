import {
  SupportChatProviderError,
  SupportHistoryFailureReasonSchema,
  SupportHistoryProviderError,
} from '@openora/core/contracts';

/**
 * What of a support adapter's failure may reach a log, the error reporter or the job queue. An
 * adapter may throw anything, such as an HTTP client error holding the vendor API key or an email,
 * in its message, its `cause` or even its writable `name`: nothing of it survives. A provider error
 * keeps its reason only when it is a listed code, since a JavaScript adapter can pass any text.
 */
export const reasonOf = (err: unknown): string => {
  // A getter or a proxy trap can throw while it is read, and its error is the adapter's too.
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
