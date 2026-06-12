import type { PluginEntry } from '@oss/plugin-host';
import type { ContractRouter } from '@orpc/contract';
import { leaderboardContract } from '@oss-premium/leaderboard/contract';
import { sportsbookContract } from '@oss-premium/sportsbook/contract';
import { igamingAggregatorContract } from '@oss-premium/aggregator/contract';
import { playerContract } from '@oss-premium/player-management/contract';

// Edition gate for premium (sellable, extract-later) packages.
//
// This is the SINGLE place that knows which premium modules exist in this build.
// A premium module is "shippable" only when it appears BOTH here (its contract
// slice) and in extensions.config.ts with kind:'premium' (its runtime plugin).
//
// Extraction later = delete its line from PREMIUM_CONTRACTS + its extensions.config
// entry. Nothing in the free OSS core references premium (enforced by
// no-core-to-premium), so removing a premium module never breaks core. Only this
// composition root (apps/*) is allowed to import @oss-premium/*. See ADR-0020.
//
// oxlint-disable-next-line typescript/no-explicit-any -- root contract is an external oRPC generic
type AnyContract = ContractRouter<any>;

// Keyed by the extensions.config plugin id (what applyEdition filters on, what the
// operator lists in OSS_PREMIUM). `namespace` is the key the slice merges under in
// the root contract (= its OpenAPI/typed-client namespace) - usually equal to the
// id, but aggregator historically used `igamingAggregator`.
type PremiumEntry = { namespace: string; contract: AnyContract };

const PREMIUM: Record<string, PremiumEntry> = {
  leaderboard: { namespace: 'leaderboard', contract: leaderboardContract },
  sportsbook: { namespace: 'sportsbook', contract: sportsbookContract },
  aggregator: { namespace: 'igamingAggregator', contract: igamingAggregatorContract },
  'player-management': { namespace: 'player', contract: playerContract },
};

// OSS_PREMIUM selects which premium modules this process enables:
//   unset        -> ALL available premium modules (dev/monorepo "full" edition)
//   "" or "none" -> NONE (the free OSS edition)
//   "*" / "all"  -> ALL
//   "a,b,c"      -> exactly that subset
export function enabledPremium(): Set<string> {
  const all = new Set(Object.keys(PREMIUM));
  const raw = process.env['OSS_PREMIUM'];
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

// Drop premium plugin entries that this edition does not enable, so they never
// load and their routes are never served.
export function applyEdition(entries: PluginEntry[]): PluginEntry[] {
  const enabled = enabledPremium();
  return entries.filter((e) => e.kind !== 'premium' || enabled.has(e.id));
}

// Merge the enabled premium contract slices into the core contract so the emitted
// OpenAPI spec advertises exactly the routes this edition actually serves.
export function withPremiumContracts(core: AnyContract): AnyContract {
  const enabled = enabledPremium();
  const merged: Record<string, AnyContract> = { ...(core as Record<string, AnyContract>) };
  for (const [id, entry] of Object.entries(PREMIUM)) {
    if (enabled.has(id)) merged[entry.namespace] = entry.contract;
  }
  return merged as AnyContract;
}
