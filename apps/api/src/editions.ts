import type { PluginEntry } from '@oss/core/server';
import type { ContractRouter } from '@orpc/contract';
import { composeContract } from '@oss/core/contracts';
// Core (always-loaded) contract slices. Each module OWNS its slice; this
// composition root is the ONE place that assembles them into the runtime
// contract - aggregation never lives in a shared package. See ADR-0021.
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
// Gated (optional, extract-later) contract slices.
import { leaderboardContract } from '@oss/core/engagement/contracts/leaderboard';
import { sportsbookContract } from '@oss/core/sportsbook/contract';
import { igamingAggregatorContract } from '@oss/core/casino/contracts/aggregator';
import { playerContract } from '@oss/core/pam/contracts/player';

// Edition gate for add-on (optional, extract-later) packages.
//
// This is the SINGLE place that knows which add-on modules exist in this build.
// An add-on module is enabled only when it appears BOTH here (its contract slice)
// and in extensions.config.ts with kind:'addon' (its runtime plugin).
//
// Extraction later = delete its line from the ADDONS registry + its extensions.config
// entry. Nothing in the core OSS build references an add-on (enforced by
// no-core-to-addon), so removing an add-on module never breaks core. Only this
// composition root (apps/*) is allowed to import @oss-addons/*. See ADR-0020.
//
// oxlint-disable-next-line typescript/no-explicit-any -- root contract is an external oRPC generic
type AnyContract = ContractRouter<any>;

// The always-loaded core slices, keyed by their root-contract namespace
// (= OpenAPI/typed-client namespace). `health` is added first by composeContract.
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

// Keyed by the extensions.config plugin id (what applyEdition filters on, what the
// operator lists in OSS_ADDONS). `namespace` is the key the slice merges under in
// the root contract (= its OpenAPI/typed-client namespace) - usually equal to the
// id, but aggregator historically used `igamingAggregator`.
type AddonEntry = { namespace: string; contract: AnyContract };

const ADDONS: Record<string, AddonEntry> = {
  leaderboard: { namespace: 'leaderboard', contract: leaderboardContract },
  sportsbook: { namespace: 'sportsbook', contract: sportsbookContract },
  aggregator: { namespace: 'igamingAggregator', contract: igamingAggregatorContract },
  'player-management': { namespace: 'player', contract: playerContract },
};

// OSS_ADDONS selects which add-on modules this process enables:
//   unset        -> ALL available add-on modules (dev/monorepo "full" edition)
//   "" or "none" -> NONE (the default OSS build)
//   "*" / "all"  -> ALL
//   "a,b,c"      -> exactly that subset
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

// Drop add-on plugin entries that this edition does not enable, so they never
// load and their routes are never served.
export function applyEdition(entries: PluginEntry[]): PluginEntry[] {
  const enabled = enabledAddons();
  return entries.filter((e) => e.kind !== 'addon' || enabled.has(e.id));
}

// Assemble the runtime contract for this edition: health + core slices, plus the
// gated add-on slices this process enables (OSS_ADDONS) when `includeAddons`. This
// is the single aggregation point - the consumer's composition root. The running
// server includes enabled add-ons (so served routes match); the committed
// docs/openapi.json stays the canonical CORE surface (no gated/premium routes).
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
