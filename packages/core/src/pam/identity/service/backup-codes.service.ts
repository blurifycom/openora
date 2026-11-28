import { createLogger, type Auth } from '@openora/core/server';
import type { User } from '@openora/core/contracts';

const logger = createLogger('backup-codes');

type BackupCodesApi = {
  viewBackupCodes(opts: { body: { userId: string } }): Promise<{ backupCodes: string[] }>;
};

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
