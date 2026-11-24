import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { WalletCommands } from '@openora/core/contracts';
import type { DrizzleService } from '@openora/core/server';
import { makeAuditWriter, makeEventBus, mock } from '../../../testing/mock.js';
import {
  GrantConversionService,
  TransferGrantConversionUnavailableError,
  TransferGrantConversionWalletUnavailableError,
} from '../service/grant-conversion.service.js';

const service = (wallet: WalletCommands | undefined, turnoverOn = true) =>
  new GrantConversionService(
    mock<DrizzleService>({}),
    makeAuditWriter(),
    makeEventBus(),
    () => wallet,
    turnoverOn,
    { error: vi.fn() },
  );

const input = { limit: 100, dryRun: false };
const actor = { id: randomUUID() };

describe('GrantConversionService wallet ports', () => {
  it('refuses as wallet_unavailable while turnover is on and no wallet is bound', async () => {
    const refused = service(undefined).convert({ ...input, sources: ['gift'] }, actor);

    await expect(refused).rejects.toBeInstanceOf(TransferGrantConversionWalletUnavailableError);
    await expect(refused).rejects.toMatchObject({ data: { reason: 'wallet_unavailable' } });
  });

  it('refuses as wallet_unavailable when the wallet lacks the turnover commands', async () => {
    const wallet = mock<WalletCommands>({ credit: vi.fn() });

    await expect(
      service(wallet).convert({ ...input, sources: ['gift'] }, actor),
    ).rejects.toMatchObject({
      data: { reason: 'wallet_unavailable' },
    });
  });

  it('answers turnover_disabled first while the multiplier is 0', async () => {
    await expect(
      service(undefined, false).convert({ ...input, sources: ['gift'] }, actor),
    ).rejects.toBeInstanceOf(TransferGrantConversionUnavailableError);
  });
});
