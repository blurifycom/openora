#!/usr/bin/env node
/**
 * Assembles the full runtime contract from all domain + add-on slices.
 * Used by gen-openapi.ts and as a reference for consumer composition roots.
 * Each domain owns its own /contracts slice; this file is the only place that
 * stitches them together. See ADR-0021/0025.
 */
import type { ContractRouter } from '@orpc/contract';
import { composeContract } from '@blurifycom/core/contracts';
import { identityContract } from '@blurifycom/core/pam/contracts/identity';
import { complianceContract } from '@blurifycom/core/compliance/contracts';
import { profileContract } from '@blurifycom/core/pam/contracts/profile';
import { cmsContract } from '@blurifycom/core/cms/contracts';
import { notificationsContract } from '@blurifycom/core/engagement/contracts/notifications';
import { bonusContract } from '@blurifycom/core/engagement/contracts/bonus';
import { chatContract } from '@blurifycom/core/engagement/contracts/chat';
import { walletContract } from '@blurifycom/core/wallet/contract';
import { gamingContract } from '@blurifycom/core/casino/contracts/gaming';
import { lobbyContract } from '@blurifycom/core/casino/contracts/lobby';
import { backofficeContract } from '@blurifycom/core/admin-console/contract';
import { iamContract } from '@blurifycom/core/iam/contract';
import { auditContract } from '@blurifycom/core/audit/contract';
import { leaderboardContract } from '@blurifycom/core/engagement/contracts/leaderboard';
import { sportsbookContract } from '@blurifycom/core/sportsbook/contract';
import { igamingAggregatorContract } from '@blurifycom/core/casino/contracts/aggregator';
import { playerContract } from '@blurifycom/core/pam/contracts/player';

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
  bonus: bonusContract,
  chat: chatContract,
  lobby: lobbyContract,
  backoffice: backofficeContract,
  profile: profileContract,
  iam: iamContract,
  audit: auditContract,
};

type AddonEntry = { namespace: string; contract: AnyContract };

// namespace is the root-contract key; aggregator historically diverged from its id.
const ADDONS: Record<string, AddonEntry> = {
  leaderboard: { namespace: 'leaderboard', contract: leaderboardContract },
  sportsbook: { namespace: 'sportsbook', contract: sportsbookContract },
  aggregator: { namespace: 'igamingAggregator', contract: igamingAggregatorContract },
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
