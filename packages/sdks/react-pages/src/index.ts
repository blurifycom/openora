// Top-level convenience barrel re-exporting everything from the three layered
// packages plus this package's own pages, theme, ui-plugin, and the composed
// `OssProviders` wrapper. Consumers may either:
//   - import from this barrel: `import { PlayerLobbyPage, useOrpcClient } from '@oss/react-pages'`
//   - or import via subpath for narrower surface:
//       `import { useOrpcClient } from '@oss/react-hooks'`
//       `import { PlayerLobbyPage } from '@oss/react-pages/player'`
//
// The subpath approach is required for RSC (use `@oss/react-hooks/server`).

// Composite provider
export { OssProviders, type OssProvidersProps } from './oss-providers.js';

// Re-export the hooks/transport surface (so consumers can import either via this barrel
// or directly from `@oss/react-hooks`).
export {
  createClient,
  type OssClient,
  type CreateClientOptions,
  contract,
  ApiClientProvider,
  useApiClient,
  useOrpcClient,
  useSession,
  useLogin,
  useLogout,
  useRegister,
  useCurrentUser,
  UIProvider,
  useUI,
  usePaginatedList,
  type PaginatedListState,
  useEventStream,
  type EventStreamStatus,
  type UseEventStreamOptions,
  type UseEventStreamResult,
} from '@oss/react-hooks';

// Re-export the admin shell blocks.
export {
  AuthGuard,
  StatCard,
  Skeleton,
  SkeletonText,
  SkeletonDetail,
  TimeSeriesChart,
  type TimeSeriesPoint,
  Pagination,
} from '@oss/react-blocks/admin';

// Composed shells specific to this package.
export { AppShell, type AppShellNavItem } from './shell/app-shell.js';

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

// Admin pages
export { LoginPage } from './admin/login.js';
export { DashboardPage } from './admin/dashboard.js';
export { UsersListPage } from './admin/users.js';
export { UserDetailPage } from './admin/user-detail.js';
export { GamesPage } from './admin/games.js';
export { PlayersListPage } from './admin/players.js';
export { PlayerDetailPage } from './admin/player-detail.js';
export { PlayersDashboardPage } from './admin/players-dashboard.js';

// Player pages
export { PlayerLobbyPage, type PlayerLobbyPageProps } from './player/lobby.js';
export { PlayerGamesPage, type PlayerGamesPageProps } from './player/games.js';
export { PlayerWalletPage } from './player/wallet.js';
export { PlayerSportsbookPage, type PlayerSportsbookPageProps } from './player/sportsbook.js';

// UI plugin system (extension points - see ADR-0006 + ADR-0013)
export {
  defineUIPlugin,
  buildRegistry,
  UIPluginProvider,
  RegisteredRoute,
  useUIRegistry,
  useNavItems,
  useRegisteredRoutes,
  SlotEvaluationContextProvider,
  useSlotEvaluationContext,
  Slot,
  useSlotFills,
  useSlotColumns,
  defineSlotFill,
  SLOTS,
  isFillVisible,
  defaultSlotEvaluationContext,
  type UIPlugin,
  type UIRegistry,
  type SlotFill,
  type ColumnFill,
  type SlotFillMode,
  type SlotContribution,
  type ColumnContribution,
  type SlotGatingProps,
  type SlotEvaluationContext,
  type SlotProps,
  type SlotName,
  type ColumnSlotName,
  type RegisteredRouteDescriptor,
} from './ui-plugin/index.js';
