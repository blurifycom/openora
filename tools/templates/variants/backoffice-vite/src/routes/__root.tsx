import { Outlet, createRootRoute } from '@tanstack/react-router';

// Root just renders the matched route. The `_authed` pathless layout adds the
// AuthGuard + AppShell chrome; `/login` sits outside it.
export const Route = createRootRoute({
  component: () => <Outlet />,
});
