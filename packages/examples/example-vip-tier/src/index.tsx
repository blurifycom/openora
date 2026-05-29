/**
 * @oss/example-vip-tier - reference UI plugin exercising every v1 extension
 * surface. Operators copy this as a starter and replace the VIP-tier data
 * source with their own.
 *
 * What this plugin does:
 *
 * 1. T1 column on players list (`players:columns`) showing the VIP tier of
 *    each row. Gated by `requiresPermission: 'players:read:vip'` and the T0
 *    feature flag `vipTier`. brandScope is `['casino-uk']`.
 *
 * 2. T1 section on player detail (`player:detail:sections`) rendering a VIP
 *    panel. Reads the active player from the page context via
 *    `usePageContext<PlayerDetailPageContext>()` and the VIP tier via
 *    `useDataExtension('vip-tier', 'tier', fetcher, [playerId])`.
 *
 * 3. T1 ribbon on the player lobby (`player:lobby:ribbon`) advertising the
 *    VIP program. Gated by the same `vipTier` feature flag.
 *
 * 4. T1 game-tile decorator (`player:game-tile:decorator`) showing a small
 *    "VIP" badge on games eligible for VIP cashback (sample logic).
 *
 * 5. Cross-cutting `useDataExtension('vip-tier', 'tier', fetcher, [playerId])`
 *    keys per-player so two slots reading the same player share one fetch.
 *
 * 6. Sealed-token typecheck demo - see `./sealed-fail-demo.ts`. The
 *    `@ts-expect-error` directive in that file proves that
 *    `ctx.provide(RG_SELF_EXCLUSION_SERVICE, ...)` does not typecheck. If the
 *    seal regresses the directive becomes unused and TS flags it.
 *
 * 7. Self-test on import via `assertValidPlugin()` (plugin-test-kit). If a
 *    slot name typo, missing render, or unknown slot is introduced, the
 *    consumer's build fails fast.
 */

import type { ReactNode } from 'react';
import {
  defineUIPlugin,
  defineSlotFill,
  SLOTS,
  type UIPlugin,
  type PlayerDetailPageContext,
} from '@oss/react-pages';
import { usePageContext, useDataExtension } from '@oss/react-hooks';
import { assertValidPlugin } from '@oss/plugin-test-kit';

type PlayerRow = { id: string; userId: string; level: number } & Record<string, unknown>;

type VipTier = {
  tier: 'BRONZE' | 'SILVER' | 'GOLD' | 'PLATINUM';
  points: number;
};

/**
 * Demo fetcher. In a real plugin this would call the operator's VIP service.
 * Kept inline here so the reference plugin is self-contained.
 */
async function fetchVipTier(playerId: string): Promise<VipTier> {
  const hash = [...playerId].reduce((a, c) => a + c.charCodeAt(0), 0);
  const tiers: VipTier['tier'][] = ['BRONZE', 'SILVER', 'GOLD', 'PLATINUM'];
  return { tier: tiers[hash % tiers.length] ?? 'BRONZE', points: 1000 + (hash % 9000) };
}

function VipColumnCell({ row }: { row: PlayerRow }): ReactNode {
  const tier = row.level >= 5 ? 'GOLD' : row.level >= 3 ? 'SILVER' : null;
  if (!tier) return null;
  return <span data-testid="vip-tier-cell">{tier}</span>;
}

/**
 * VIP section on player detail. Consumes `PlayerDetailPageContext` from the
 * host page; if the page didn't mount a `<PageContextProvider>`, `usePageContext`
 * throws and the plugin's bug is surfaced at the source.
 */
function VipSection(): ReactNode {
  const { player } = usePageContext<PlayerDetailPageContext>();
  const playerId = player?.id ?? '';
  const { data, isLoading, isError } = useDataExtension<VipTier>(
    'vip-tier',
    'tier',
    () => fetchVipTier(playerId),
    [playerId],
  );

  if (!playerId) return null;
  return (
    <section data-testid="vip-section" className="player-section">
      <h2 className="player-section__title">VIP</h2>
      {isLoading && <p>Loading VIP status...</p>}
      {isError && <p>Failed to load VIP status.</p>}
      {data && (
        <p>
          Tier <strong>{data.tier}</strong> - {data.points.toLocaleString()} points
        </p>
      )}
    </section>
  );
}

function LobbyVipRibbon(): ReactNode {
  return (
    <div data-testid="vip-ribbon" className="player-ribbon">
      Join the VIP program for exclusive rewards.
    </div>
  );
}

function GameTileVipBadge(): ReactNode {
  return <span data-testid="game-tile-vip-badge">VIP</span>;
}

export const vipTierPlugin: UIPlugin = defineUIPlugin({
  id: 'example-vip-tier',

  columns: [
    {
      name: SLOTS.players.columns,
      key: 'vipTier',
      header: 'VIP',
      render: (_value, row) => <VipColumnCell row={row as PlayerRow} />,
      featureFlag: 'vipTier',
      brandScope: ['casino-uk'],
      requiresPermission: 'players:read:vip',
    },
  ],

  slots: [
    {
      name: SLOTS.playerDetail.sections,
      id: 'vip',
      mode: 'append',
      order: 50,
      featureFlag: 'vipTier',
      render: defineSlotFill<{ id: string }>(() => <VipSection />),
    },
    {
      name: SLOTS.playerLobby.ribbon,
      id: 'vip-ribbon',
      mode: 'append',
      order: 10,
      featureFlag: 'vipTier',
      render: () => <LobbyVipRibbon />,
    },
    {
      name: SLOTS.playerGameTile.decorator,
      id: 'vip-badge',
      mode: 'append',
      order: 10,
      featureFlag: 'vipTier',
      render: defineSlotFill<{ id: string; title: string }>(() => <GameTileVipBadge />),
    },
  ],
});

// Build-time self-check via plugin-test-kit. If a slot name typo / missing
// render / duplicate id sneaks in, this throws at module load time so the
// operator's app fails fast on `pnpm dev` / `pnpm build` instead of silently
// rendering nothing.
assertValidPlugin(vipTierPlugin);

export default vipTierPlugin;
