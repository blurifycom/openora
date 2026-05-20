/**
 * UI plugin slot taxonomy. Adding a slot here is a contract change - bump the
 * docs in ADR-0006 and add a corresponding `useXxx()` consumer hook.
 */
import type { ReactNode } from 'react';
import type { TableColumn } from '@oss/ui-provider-contract';
import type { AdminUserSchema, GameSchema, PlayerSchema } from '@oss/orpc-contract';
import type { z } from 'zod';

type AdminUser = z.infer<typeof AdminUserSchema>;
type Game = z.infer<typeof GameSchema>;
type Player = z.infer<typeof PlayerSchema>;

export type AppShellNavItem = {
  href: string;
  label: string;
  icon?: (props: { width?: number; height?: number; className?: string }) => ReactNode;
};

export type TileContribution = {
  id: string;
  /** Lower order renders first. Default 100. Built-in tiles use 0..50. */
  order?: number;
  render: () => ReactNode;
};

export type SectionContribution<T> = {
  id: string;
  title: string;
  order?: number;
  render: (subject: T) => ReactNode;
};

export type ActionContribution<T> = {
  id: string;
  order?: number;
  render: (subject: T) => ReactNode;
};

export type ToolbarContribution = {
  id: string;
  order?: number;
  render: () => ReactNode;
};

export type RegisteredRoute = {
  path: string;
  element: ReactNode;
};

/**
 * The `ctx` object handed to each `defineUIPlugin({ register })` call.
 * Slots are namespaced and each exposes `.add()`. Order-of-call determines
 * render order unless an `order` override is provided.
 */
export type UIPluginContext = {
  nav: {
    add: (item: AppShellNavItem) => void;
  };
  dashboard: {
    tiles: { add: (tile: TileContribution) => void };
  };
  users: {
    columns: { add: (column: TableColumn<AdminUser>) => void };
    toolbar: { add: (item: ToolbarContribution) => void };
  };
  userDetail: {
    sections: { add: (section: SectionContribution<AdminUser>) => void };
    actions: { add: (action: ActionContribution<AdminUser>) => void };
  };
  games: {
    columns: { add: (column: TableColumn<Game>) => void };
  };
  players: {
    columns: { add: (column: TableColumn<Player>) => void };
  };
  playerDetail: {
    sections: { add: (section: SectionContribution<Player>) => void };
    actions: { add: (action: ActionContribution<Player>) => void };
  };
  routes: {
    add: (route: RegisteredRoute) => void;
  };
};

/**
 * Immutable snapshot of all plugin contributions, keyed by slot. Pages read
 * from this via the `use*` hooks in `registry.tsx`.
 */
export type UIRegistry = {
  nav: AppShellNavItem[];
  dashboardTiles: TileContribution[];
  usersColumns: TableColumn<AdminUser>[];
  usersToolbar: ToolbarContribution[];
  userDetailSections: SectionContribution<AdminUser>[];
  userDetailActions: ActionContribution<AdminUser>[];
  gamesColumns: TableColumn<Game>[];
  playersColumns: TableColumn<Player>[];
  playerDetailSections: SectionContribution<Player>[];
  playerDetailActions: ActionContribution<Player>[];
  routes: RegisteredRoute[];
};

export const emptyRegistry: UIRegistry = {
  nav: [],
  dashboardTiles: [],
  usersColumns: [],
  usersToolbar: [],
  userDetailSections: [],
  userDetailActions: [],
  gamesColumns: [],
  playersColumns: [],
  playerDetailSections: [],
  playerDetailActions: [],
  routes: [],
};
