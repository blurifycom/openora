import { createLogger, type Auth } from '@openora/core/server';
import type { User } from '@openora/core/contracts';

const logger = createLogger('backup-codes');

/**
 * Library boundary: the base Auth API type omits the endpoints the twoFactor plugin
 * contributes, and `viewBackupCodes` is server-only.
 */
type BackupCodesApi = {
  viewBackupCodes(opts: { body: { userId: string } }): Promise<{ backupCodes: string[] }>;
};

/**
 * Counts what is left of the recovery set. better-auth stores the codes encrypted unless
 * the operator opts out, so the column cannot be parsed here - the plugin's own server-only
 * reader is the one that knows how to open it. A failed read is reported as unknown rather
 * than as zero: claiming no codes remain would be worse than admitting the count cannot be
 * taken.
 */
export async function countRemainingBackupCodes(
  auth: Auth,
  userId: User['id'],
): Promise<number | null> {
  const api = auth.api as unknown as BackupCodesApi;
  try {
    const { backupCodes } = await api.viewBackupCodes({ body: { userId } });
    return backupCodes.length;
  } catch (err) {
    logger.warn({ err, userId }, 'could not read the remaining backup codes');
    return null;
  }
}
