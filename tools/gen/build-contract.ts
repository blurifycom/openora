#!/usr/bin/env node
/**
 * Assembles the full runtime contract from all domain + add-on slices.
 * Used by gen-openapi.ts and as a reference for consumer composition roots.
 * Each domain owns its own /contracts slice; this file is the only place that
 * stitches them together. See ADR-0021/0025.
 */
import type { ContractRouter } from '@orpc/contract';
import { composeContract } from '@openora/core/contracts';
import { identityContract } from '@openora/core/pam/contracts/identity';
import { complianceContract } from '@openora/core/compliance/contracts';
import { profileContract } from '@openora/core/pam/contracts/profile';
import { cmsContract } from '@openora/core/cms/contracts';
import { notificationsContract } from '@openora/core/engagement/contracts/notifications';
import { chatContract } from '@openora/core/engagement/contracts/chat';
import { walletContract } from '@openora/core/wallet/contract';
import { gamingContract } from '@openora/core/casino/contracts/gaming';
import { lobbyContract } from '@openora/core/casino/contracts/lobby';
import { backofficeContract } from '@openora/core/admin-console/contract';
import { iamContract } from '@openora/core/iam/contract';
import { auditContract } from '@openora/core/audit/contract';
import { playerContract } from '@openora/core/pam/contracts/player';
import { tagContract } from '@openora/core/pam/contracts/tag';
import { playerNoteContract } from '@openora/core/pam/contracts/player-note';

// oxlint-disable-next-line typescript/no-explicit-any -- root contract is an external oRPC generic
type AnyContract = ContractRouter<any>;

// Order mirrors the historical aggregate so the emitted OpenAPI paths stay stable.
const CORE: Record<string, AnyContract> = {
  identity: identityContract,
  cms: cmsContract,
  compliance: complianceContract,
  notifications: notificationsContract,
  wallet: walletContract,
  gaming: gamingContract,
  chat: chatContract,
  lobby: lobbyContract,
  backoffice: backofficeContract,
  profile: profileContract,
  iam: iamContract,
  audit: auditContract,
  tag: tagContract,
  'player-note': playerNoteContract,
};

type AddonEntry = { namespace: string; contract: AnyContract };

const ADDONS: Record<string, AddonEntry> = {
  'player-management': { namespace: 'player', contract: playerContract },
};

/** Returns the set of add-on ids enabled by OSS_ADDONS (default: all). */
export function enabledAddons(): Set<string> {
  const all = new Set(Object.keys(ADDONS));
  const raw = process.env['OSS_ADDONS'];
  if (raw === undefined) return all;
  const v = raw.trim().toLowerCase();
  if (v === '' || v === 'none') return new Set();
  if (v === '*' || v === 'all') return all;
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Compose the full runtime contract from core + enabled add-on slices. */
export function buildContract({
  includeAddons = true,
}: { includeAddons?: boolean } = {}): AnyContract {
  const slices: Record<string, AnyContract> = { ...CORE };
  if (includeAddons) {
    const enabled = enabledAddons();
    for (const [id, entry] of Object.entries(ADDONS)) {
      if (enabled.has(id)) slices[entry.namespace] = entry.contract;
    }
  }
  return composeContract(slices);
}
