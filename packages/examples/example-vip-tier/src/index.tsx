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
 *    panel. Reads the active player from the page context (via
 *    `usePageContext<PlayerDetailPageContext>`) and the VIP rows via the
 *    same `useDataExtension` key that the column uses - so the two share one
 *    fetch.
 *
 * 3. T1 ribbon on the player lobby (`player:lobby:ribbon`) advertising the
 *    VIP program. Gated by the same `vipTier` feature flag.
 *
 * 4. T1 game-tile decorator (`player:game-tile:decorator`) showing a small
 *    "VIP" badge on games eligible for VIP cashback (sample logic).
 *
 * 5. Cross-cutting `useDataExtension('vip-tier', 'rows', fetcher)` populates
 *    the column + tab from one fetch.
 *
 * 6. Optional sealed-token typecheck demo - see `sealed-fail-demo.ts.skip` in
 *    this folder. Uncommenting the file proves that
 *    `ctx.provide(RG_SELF_EXCLUSION_SERVICE, ...)` does not typecheck. That
 *    file is kept disabled so the package builds clean by default.
 *
 * 7. Self-test on import via `assertValidPlugin()` (plugin-test-kit). If a
 *    slot name typo, missing render, or unknown slot is introduced, the
 *    consumer's build fails fast.
 */

import type { ReactNode } from 'react';
import { defineUIPlugin, defineSlotFill, SLOTS, type UIPlugin } from '@oss/react-pages';
import { assertValidPlugin } from '@oss/plugin-test-kit';

type PlayerRow = { id: string; userId: string; level: number } & Record<string, unknown>;

/**
 * Renderer for the players-list VIP column. In real operator code this would
 * read from `useDataExtension('vip-tier', 'rows', fetcher)` keyed off the
 * player id - the row prop is passed by the DataTable.
 */
function VipColumnCell({ row }: { row: PlayerRow }): ReactNode {
  // Sample logic: anyone level >= 5 is gold.
  const tier = row.level >= 5 ? 'GOLD' : row.level >= 3 ? 'SILVER' : null;
  if (!tier) return null;
  return <span data-testid="vip-tier-cell">{tier}</span>;
}

/**
 * VIP section rendered on the player detail page. In a real plugin this
 * would `usePageContext<PlayerDetailPageContext>()` to read the player and
 * `useDataExtension('vip-tier', 'rows', fetcher)` for the data; for the
 * reference plugin we keep it inline and presentational.
 */
function VipSection({ playerId }: { playerId: string }): ReactNode {
  return (
    <section data-testid="vip-section" className="player-section">
      <h2 className="player-section__title">VIP</h2>
      <p>
        VIP program details for player <code>{playerId}</code>.
      </p>
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

  // T1 columns - extra column on players list, gated by RBAC + feature flag +
  // brand scope. Last-registration wins for replace; this `add` runs after
  // base columns.
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

  // T1 slot fills - the four extension points this reference plugin uses.
  slots: [
    {
      name: SLOTS.playerDetail.sections,
      id: 'vip',
      mode: 'append',
      order: 50,
      featureFlag: 'vipTier',
      render: defineSlotFill<{ id: string }>((player) => (
        <VipSection playerId={player.id} />
      )),
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
