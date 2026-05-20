// Transport
export { createClient, type OssClient, type CreateClientOptions } from './client.js';
export { contract } from '@oss/orpc-contract';

// React bindings - client + auth + user
export { ApiClientProvider, useApiClient } from './context/api-client.js';
export { useOrpcClient } from './hooks/use-orpc-client.js';
export { useSession, useLogin, useLogout, useRegister } from './hooks/auth.js';
export { useCurrentUser } from './hooks/user.js';

// UI provider context
export { UIProvider, useUI } from './ui-provider.js';

// Theme
export {
  ThemeProvider,
  useTheme,
  themeToCssVars,
  defaultTheme,
  themePresets,
  type Theme,
  type ThemePresetName,
} from './theme.js';

// Admin shell
export { AppShell, type AppShellNavItem } from './shell/app-shell.js';
export { AuthGuard } from './shell/auth-guard.js';
export { StatCard } from './shell/stat-card.js';
export { Skeleton, SkeletonText, SkeletonDetail } from './shell/skeleton.js';
export { TimeSeriesChart, type TimeSeriesPoint } from './shell/time-series-chart.js';

// Admin pages
export { LoginPage } from './pages/login.js';
export { DashboardPage } from './pages/dashboard.js';
export { UsersListPage } from './pages/users.js';
export { UserDetailPage } from './pages/user-detail.js';
export { GamesPage } from './pages/games.js';
export { PlayersListPage } from './pages/players.js';
export { PlayerDetailPage } from './pages/player-detail.js';
export { PlayersDashboardPage } from './pages/players-dashboard.js';

// UI plugin registry (extension points - see ADR-0006)
export {
  defineUIPlugin,
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
  type UIPlugin,
  type UIPluginContext,
  type UIRegistry,
  type TileContribution,
  type SectionContribution,
  type ActionContribution,
  type ToolbarContribution,
  type RegisteredRouteDescriptor,
} from './ui-plugin/index.js';
