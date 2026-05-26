// Composite provider
export { OssProviders, type OssProvidersProps } from './oss-providers.js';

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

// Hooks
export { usePaginatedList, type PaginatedListState } from './hooks/use-paginated-list.js';

// Admin shell
export { AppShell, type AppShellNavItem } from './shell/app-shell.js';
export { AuthGuard } from './shell/auth-guard.js';
export { StatCard } from './shell/stat-card.js';
export { Skeleton, SkeletonText, SkeletonDetail } from './shell/skeleton.js';
export { TimeSeriesChart, type TimeSeriesPoint } from './shell/time-series-chart.js';
export { Pagination } from './shell/pagination.js';

// Auth (shared by both surfaces)
export { LoginPage } from './pages/admin/login.js';

// Admin pages (backoffice surface - consumed by apps/backoffice)
export { DashboardPage } from './pages/admin/dashboard.js';
export { UsersListPage } from './pages/admin/users.js';
export { UserDetailPage } from './pages/admin/user-detail.js';
export { GamesPage } from './pages/admin/games.js';
export { PlayersListPage } from './pages/admin/players.js';
export { PlayerDetailPage } from './pages/admin/player-detail.js';
export { PlayersDashboardPage } from './pages/admin/players-dashboard.js';

// Player pages (player surface - consumed by apps/web)
export { PlayerLobbyPage } from './pages/player/lobby.js';
export { PlayerGamesPage } from './pages/player/games.js';
export { PlayerWalletPage } from './pages/player/wallet.js';

// UI plugin system (extension points - see ADR-0006)
export {
  defineUIPlugin,
  buildRegistry,
  UIPluginProvider,
  RegisteredRoute,
  useUIRegistry,
  useNavItems,
  useRegisteredRoutes,
  Slot,
  useSlotFills,
  useSlotColumns,
  defineSlotFill,
  SLOTS,
  type UIPlugin,
  type UIRegistry,
  type SlotFill,
  type SlotFillMode,
  type SlotContribution,
  type ColumnContribution,
  type SlotProps,
  type SlotName,
  type ColumnSlotName,
  type AppShellNavItem as NavItem,
  type RegisteredRouteDescriptor,
} from './ui-plugin/index.js';
