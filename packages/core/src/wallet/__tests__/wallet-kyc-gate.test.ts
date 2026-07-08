import { describe, it, expect, vi } from 'vitest';
import { mock } from '../../testing/mock.js';
import { WalletService, KycRequiredError } from '../service/wallet.service.js';

function makeDeps(kycStatus: string | null) {
  const db = {
    db: {
      transaction: vi
        .fn()
        .mockResolvedValue({ transactionId: 'tx-1', status: 'pending', replayed: false }),
    },
  };
  const events = { emit: vi.fn() };
  const payment = { processDeposit: vi.fn(), processWithdrawal: vi.fn() };
  const directory = {
    lookupPlayers: vi
      .fn()
      .mockResolvedValue(
        kycStatus === null ? [] : [{ userId: 'u-1', username: 'p', email: 'e', kycStatus }],
      ),
  };
  return { db, events, payment, directory };
}

function makeService(kycStatus: string | null, gateWithdrawals: boolean) {
  const { db, events, payment, directory } = makeDeps(kycStatus);
  const platformConfig = { kyc: { gateWithdrawals } };
  const deps = mock<ConstructorParameters<typeof WalletService>[0]>({
    drizzle: db,
    events,
    payment,
    directory,
    platformConfig,
  });
  const svc = new WalletService(deps);
  return { svc, db, directory };
}

describe('WalletService.withdraw KYC gate', () => {
  it('throws KycRequiredError when the gate is on and status is not in the pass-set', async () => {
    const { svc, db } = makeService('pending', true);
    await expect(
      svc.withdraw({ userId: 'u-1', amount: 50, currency: 'USD' }),
    ).rejects.toBeInstanceOf(KycRequiredError);
    expect(db.db.transaction).not.toHaveBeenCalled();
  });

  it('fails closed when the gate is on and the player has no KYC summary', async () => {
    const { svc } = makeService(null, true);
    await expect(
      svc.withdraw({ userId: 'u-1', amount: 50, currency: 'USD' }),
    ).rejects.toBeInstanceOf(KycRequiredError);
  });

  it('allows a verified player through the gate', async () => {
    const { svc } = makeService('verified', true);
    const result = await svc.withdraw({ userId: 'u-1', amount: 50, currency: 'USD' });
    expect(result).toEqual({ transactionId: 'tx-1', status: 'pending' });
  });

  it('allows a manually_overridden player through the gate', async () => {
    const { svc } = makeService('manually_overridden', true);
    const result = await svc.withdraw({ userId: 'u-1', amount: 50, currency: 'USD' });
    expect(result.status).toBe('pending');
  });

  it('does not consult KYC when the gate is off', async () => {
    const { svc, directory } = makeService('pending', false);
    const result = await svc.withdraw({ userId: 'u-1', amount: 50, currency: 'USD' });
    expect(result.status).toBe('pending');
    expect(directory.lookupPlayers).not.toHaveBeenCalled();
  });
});
