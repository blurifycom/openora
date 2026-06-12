import type { PluginEntry } from '@oss/plugin-host';
import type { ContractRouter } from '@orpc/contract';
import { leaderboardContract } from '@oss-addons/leaderboard/contract';
import { sportsbookContract } from '@oss-addons/sportsbook/contract';
import { igamingAggregatorContract } from '@oss-addons/aggregator/contract';
import { playerContract } from '@oss-addons/player-management/contract';

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

// Merge the enabled add-on contract slices into the core contract so the emitted
// OpenAPI spec advertises exactly the routes this edition actually serves.
export function withAddonContracts(core: AnyContract): AnyContract {
  const enabled = enabledAddons();
  const merged: Record<string, AnyContract> = { ...(core as Record<string, AnyContract>) };
  for (const [id, entry] of Object.entries(ADDONS)) {
    if (enabled.has(id)) merged[entry.namespace] = entry.contract;
  }
  return merged as AnyContract;
}
