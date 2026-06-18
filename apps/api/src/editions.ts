// Each module owns its contract slice; this root assembles the runtime contract - aggregation never lives in a shared package. See ADR-0021.
import type { PluginEntry } from '@oss/core/server';
import type { ContractRouter } from '@orpc/contract';
import { composeContract } from '@oss/core/contracts';
import { identityContract } from '@oss/core/pam/contracts/identity';
import { complianceContract } from '@oss/core/compliance/contracts';
import { profileContract } from '@oss/core/pam/contracts/profile';
import { cmsContract } from '@oss/core/cms/contracts';
import { notificationsContract } from '@oss/core/engagement/contracts/notifications';
import { bonusContract } from '@oss/core/engagement/contracts/bonus';
import { chatContract } from '@oss/core/engagement/contracts/chat';
import { walletContract } from '@oss/core/wallet/contract';
import { gamingContract } from '@oss/core/casino/contracts/gaming';
import { lobbyContract } from '@oss/core/casino/contracts/lobby';
import { backofficeContract } from '@oss/core/admin-console/contract';
import { iamContract } from '@oss/core/iam/contract';
import { auditContract } from '@oss/core/audit/contract';
import { leaderboardContract } from '@oss/core/engagement/contracts/leaderboard';
import { sportsbookContract } from '@oss/core/sportsbook/contract';
import { igamingAggregatorContract } from '@oss/core/casino/contracts/aggregator';
import { playerContract } from '@oss/core/pam/contracts/player';

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

// `namespace` is the root-contract key - usually equals the id, but aggregator historically used `igamingAggregator`.
type AddonEntry = { namespace: string; contract: AnyContract };

// composition root (apps/*) is the only place allowed to import @oss-addons/*. See ADR-0020.
const ADDONS: Record<string, AddonEntry> = {
  leaderboard: { namespace: 'leaderboard', contract: leaderboardContract },
  sportsbook: { namespace: 'sportsbook', contract: sportsbookContract },
  aggregator: { namespace: 'igamingAggregator', contract: igamingAggregatorContract },
  'player-management': { namespace: 'player', contract: playerContract },
};

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

export function applyEdition(entries: PluginEntry[]): PluginEntry[] {
  const enabled = enabledAddons();
  return entries.filter((e) => e.kind !== 'addon' || enabled.has(e.id));
}

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
