/**
 * Typed registry of all named UI slots in the admin shell.
 *
 * Always import SLOTS instead of using bare strings - you get autocomplete,
 * typo protection, and the MCP list-extension-points tool surfaces these.
 *
 * Naming convention: namespace:entity:location
 *
 * Fill modes:
 *   'append'  - renders after page default content (default)
 *   'prepend' - renders before page default content
 *   'replace' - replaces page default content entirely
 *
 * Declare a new slot in a page:
 *   <Slot name={SLOTS.playerDetail.sections} subject={player}>
 *     <DefaultContent />
 *   </Slot>
 *
 * Fill a slot in a plugin:
 *   ctx.slots.fill(
 *     SLOTS.playerDetail.sections,
 *     { id: 'my-section', mode: 'append', order: 40 },
 *     defineSlotFill<Player>(player => <MySection player={player} />),
 *   );
 *
 * Add a new slot: add an entry here, then add <Slot name={SLOTS.x.y} /> in the page.
 * No other files need to change.
 */
export const SLOTS = {
  /** Player detail page - sections below the info card. Subject: Player */
  playerDetail: {
    /** Collapsible sections in the player detail body. Subject: Player */
    sections: 'player:detail:sections',
    /** Action buttons in the player detail page header. Subject: Player */
    actions: 'player:detail:actions',
  },

  /** User (admin) detail page. Subject: AdminUser */
  userDetail: {
    /** Sections in the user detail body. Subject: AdminUser */
    sections: 'user:detail:sections',
    /** Action buttons in the user detail page header. Subject: AdminUser */
    actions: 'user:detail:actions',
  },

  /** Dashboard page. */
  dashboard: {
    /** Stat cards in the dashboard grid. Subject: void */
    tiles: 'dashboard:tiles',
  },

  /** Players list page. */
  players: {
    /** Toolbar controls above the players DataTable. Subject: void */
    toolbar: 'players:toolbar',
    /**
     * Extra DataTable columns for the players list.
     * Use ctx.slots.column(), not ctx.slots.fill().
     */
    columns: 'players:columns',
  },

  /** Users list page. */
  users: {
    /** Toolbar controls above the users DataTable. Subject: void */
    toolbar: 'users:toolbar',
    /**
     * Extra DataTable columns for the users list.
     * Use ctx.slots.column(), not ctx.slots.fill().
     */
    columns: 'users:columns',
  },

  /** Games list page. */
  games: {
    /**
     * Extra DataTable columns for the games list.
     * Use ctx.slots.column(), not ctx.slots.fill().
     */
    columns: 'games:columns',
  },
} as const satisfies Record<string, Record<string, string>>;

export type SlotName = (typeof SLOTS)[keyof typeof SLOTS][keyof (typeof SLOTS)[keyof typeof SLOTS]];

/** Slot names that accept column definitions via ctx.slots.column() */
export type ColumnSlotName =
  | typeof SLOTS.players.columns
  | typeof SLOTS.users.columns
  | typeof SLOTS.games.columns;
