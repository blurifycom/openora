import { describe, expect, it, vi } from 'vitest';
import { KycRequiredError, WalletService } from '../wallet.service.js';

type Gate = (
  userId: string,
  tx: { amount: string; currency: string },
  meta: { ip?: string; userAgent?: string },
) => Promise<void>;

// The gate only touches three collaborators, so the service is built bare and given just those.
function gate(opts: {
  blocks: boolean;
  playerId?: string | null;
  record?: ReturnType<typeof vi.fn>;
}) {
  const record = opts.record ?? vi.fn().mockResolvedValue(undefined);
  const service = Object.create(WalletService.prototype) as Record<string, unknown>;
  service['kycBlocksWithdrawal'] = vi.fn().mockResolvedValue(opts.blocks);
  service['identityReader'] = {
    getPlayerIdByUserIdSafe: vi.fn().mockResolvedValue(opts.playerId ?? null),
  };
  service['audit'] = { record };
  const run = (service['assertKycForWithdrawal'] as Gate).bind(service);
  return { run, record };
}

const tx = { amount: '10', currency: 'USDT' };
const meta = { ip: '203.0.113.9', userAgent: 'test' };

describe('assertKycForWithdrawal audit', () => {
  it('audits the refusal under the user, filed on the player, before throwing', async () => {
    const { run, record } = gate({ blocks: true, playerId: 'player-1' });

    await expect(run('user-1', tx, meta)).rejects.toBeInstanceOf(KycRequiredError);

    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      actorType: 'player',
      actorId: 'user-1',
      action: 'wallet.withdrawal.kyc_required',
      resourceType: 'player',
      resourceId: 'player-1',
      result: 'failure',
      after: { amount: '10', currency: 'USDT' },
      ...meta,
    });
  });

  it('files the row on the user when there is no player', async () => {
    const { run, record } = gate({ blocks: true, playerId: null });

    await expect(run('user-1', tx, meta)).rejects.toBeInstanceOf(KycRequiredError);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ resourceType: 'user', resourceId: 'user-1' }),
    );
  });

  it('still refuses when the audit write fails', async () => {
    const record = vi.fn().mockRejectedValue(new Error('audit down'));
    const { run } = gate({ blocks: true, playerId: 'player-1', record });

    await expect(run('user-1', tx, meta)).rejects.toBeInstanceOf(KycRequiredError);
  });

  it('writes nothing when KYC does not block the withdrawal', async () => {
    const { run, record } = gate({ blocks: false });

    await expect(run('user-1', tx, meta)).resolves.toBeUndefined();

    expect(record).not.toHaveBeenCalled();
  });
});
