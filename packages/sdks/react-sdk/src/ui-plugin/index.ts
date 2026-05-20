export { defineUIPlugin, buildRegistry, type UIPlugin } from './define.js';
export {
  UIPluginProvider,
  RegisteredRoute,
  useUIRegistry,
  useNavItems,
  useDashboardTiles,
  useUsersColumns,
  useUsersToolbar,
  useUserDetailSections,
  useUserDetailActions,
  useGamesColumns,
  usePlayersColumns,
  usePlayerDetailSections,
  usePlayerDetailActions,
  useRegisteredRoutes,
} from './registry.js';
export type {
  AppShellNavItem,
  TileContribution,
  SectionContribution,
  ActionContribution,
  ToolbarContribution,
  RegisteredRoute as RegisteredRouteDescriptor,
  UIPluginContext,
  UIRegistry,
} from './context.js';
